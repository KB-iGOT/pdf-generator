import express from 'express'
import { logError, logInfo } from './utils/logger'
import axios from 'axios'
import { axiosRequestConfig, axiosRequestConfigVeryLong } from './configs/request.config'

const puppeteer = require('puppeteer')

const app = express()
const port = 3000
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb' }))

const unknownError = 'Failed due to unknown reason'
const BROWSER_POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE) || 10
const MAX_PAGES_PER_BROWSER = Number(process.env.MAX_PAGES_PER_BROWSER) || 3
const MAX_CONCURRENT_RENDERS = BROWSER_POOL_SIZE * MAX_PAGES_PER_BROWSER
const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 30000
const QUEUE_TIMEOUT = Number(process.env.QUEUE_TIMEOUT) || 60000

const API_END_POINTS = {
  downloadCert: (certId: string) => `http://cert-registry-service:9000/certs/v2/registry/download/${certId}`,
  downloadMilestoneCert: (certId) =>
    `http://certificate-generator-service:9000/v1/public/milestone/achievement/download/${certId}`
}

// --- Browser pool ---
const browserPool: Array<{ browser: any; activePages: number; totalPagesServed: number }> = []
const MAX_PAGES_BEFORE_RECYCLE = Number(process.env.MAX_PAGES_BEFORE_RECYCLE) || 200
const RECYCLE_CHECK_INTERVAL = 60000 // check every 60 seconds

async function createBrowserEntry(): Promise<{ browser: any; activePages: number; totalPagesServed: number }> {
  const browser = await puppeteer.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
    ]
  })
  const entry = { browser, activePages: 0, totalPagesServed: 0 }
  browser.on('disconnected', () => {
    logInfo('Browser disconnected, removing from pool')
    const idx = browserPool.indexOf(entry)
    if (idx !== -1) browserPool.splice(idx, 1)
  })
  return entry
}

async function initBrowserPool() {
  for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
    const entry = await createBrowserEntry()
    browserPool.push(entry)
    logInfo(`Browser ${i + 1}/${BROWSER_POOL_SIZE} launched`)
  }
}

// Periodic recycling: recycles idle browsers that have served pages, even when no traffic
async function recycleIdleBrowsers() {
  for (let i = browserPool.length - 1; i >= 0; i--) {
    const entry = browserPool[i]
    if (entry.activePages === 0 && entry.totalPagesServed >= MAX_PAGES_BEFORE_RECYCLE) {
      logInfo(`Recycling idle browser after ${entry.totalPagesServed} pages served`)
      browserPool.splice(i, 1)
      try { await entry.browser.close() } catch (_) {}
      try {
        const newEntry = await createBrowserEntry()
        browserPool.push(newEntry)
        logInfo('Replacement browser launched, pool size:', String(browserPool.length))
      } catch (err) {
        logError('Failed to create replacement browser:', err)
      }
    }
  }
}

setInterval(() => {
  recycleIdleBrowsers().catch(err => logError('Recycle check failed:', err))
}, RECYCLE_CHECK_INTERVAL)

async function acquirePage(): Promise<{ page: any; entry: { browser: any; activePages: number; totalPagesServed: number } }> {
  while (browserPool.length < BROWSER_POOL_SIZE) {
    try {
      const entry = await createBrowserEntry()
      browserPool.push(entry)
      logInfo('Replenished browser, pool size:', String(browserPool.length))
    } catch (err) {
      logError('Failed to replenish browser:', err)
      break
    }
  }
  const entry = browserPool.reduce((a, b) => a.activePages <= b.activePages ? a : b)
  if (entry.activePages >= MAX_PAGES_PER_BROWSER) {
    throw new Error('All browser slots full')
  }
  entry.activePages++
  entry.totalPagesServed++
  const page = await entry.browser.newPage()
  return { page, entry }
}

async function releasePage(page: any, entry: { browser: any; activePages: number; totalPagesServed: number }) {
  if (page) {
    try { await page.close() } catch (_) {}
  }
  entry.activePages = Math.max(0, entry.activePages - 1)

  // Recycle browser inline if threshold reached and no active pages
  if (entry.totalPagesServed >= MAX_PAGES_BEFORE_RECYCLE && entry.activePages === 0) {
    logInfo(`Recycling browser after ${entry.totalPagesServed} pages served`)
    const idx = browserPool.indexOf(entry)
    if (idx !== -1) browserPool.splice(idx, 1)
    try { await entry.browser.close() } catch (_) {}
    try {
      const newEntry = await createBrowserEntry()
      browserPool.push(newEntry)
      logInfo('Replacement browser launched, pool size:', String(browserPool.length))
    } catch (err) {
      logError('Failed to create replacement browser:', err)
    }
  }
}

// --- Concurrency limiter ---
let activeRenders = 0
const waitQueue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = []

function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const entry: { resolve: () => void; timer: ReturnType<typeof setTimeout> } = { resolve, timer: null as any }
    entry.timer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry)
      if (idx !== -1) waitQueue.splice(idx, 1)
      reject(new Error('Render queue timeout - service is overloaded'))
    }, QUEUE_TIMEOUT)
    waitQueue.push(entry)
  })
}

function releaseRenderSlot(): void {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!
    clearTimeout(next.timer)
    next.resolve()
  } else {
    activeRenders = Math.max(0, activeRenders - 1)
  }
}

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.get('/liveness', (req, res) => {
  res.status(200).send('ok')
})

app.get('/readiness', (req, res) => {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    return res.status(503).send('Service busy')
  }
  res.status(200).send('ok')
})

app.post('/public/v8/course/batch/cert/download/mobile', async (req, res) => {
  try {
    const svgContent = req.body.printUri
    if (req.body.outputFormat === 'svg') {
      const _decodedSvg = decodeURIComponent(svgContent.replace(/data:image\/svg\+xml,/, '')).replace(/\<!--\s*[a-zA-Z0-9\-]*\s*--\>/g, '')
      res.type('html')
      res.status(200).send(_decodedSvg)
    } else if (req.body.outputFormat === 'pdf') {
      await acquireRenderSlot()
      let page = null
      let entry = null
      try {
        const acquired = await acquirePage()
        page = acquired.page
        entry = acquired.entry
        await page.goto(svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
        const buffer = await page.pdf({ printBackground: true, width: '1204px', height: '662px' })
        res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buffer.length })
        res.send(buffer)
      } finally {
        await releasePage(page, entry)
        releaseRenderSlot()
      }
    } else if (req.body.outputFormat === 'png') {
      await acquireRenderSlot()
      let page = null
      let entry = null
      try {
        const acquired = await acquirePage()
        page = acquired.page
        entry = acquired.entry
        await page.goto(svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
        const selector = 'svg'
        await page.waitForSelector(selector, { timeout: PAGE_TIMEOUT })
        const element = await page.$(selector)
        const buffer = await element.screenshot({ printBackground: false })
        res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
        res.send(buffer)
      } finally {
        await releasePage(page, entry)
        releaseRenderSlot()
      }
    }
  } catch (err) {
    logError(err)
    if (err.message && err.message.includes('queue timeout')) {
      return res.status(503).send({ error: 'Service is overloaded, please retry later' })
    }
    res.status((err && err.response && err.response.status) || 500).send(
      (err && err.response && err.response.data) || {
        error: unknownError,
      }
    )
  }
})

app.get('/public/v8/cert/download/:certId', async (req, res) => {
  try {
    const certId = req.params.certId
    logInfo('inside method - certId: ', certId)
    const response = await axios.get(API_END_POINTS.downloadCert(certId),
      { ...axiosRequestConfig })
    if (response && response.data && response.data.result && response.data.result.printUri) {
      const svgContent = response.data.result.printUri
      await acquireRenderSlot()
      let page = null
      let entry = null
      try {
        const acquired = await acquirePage()
        page = acquired.page
        entry = acquired.entry
        await page.setViewport({ width: 1920, height: 1080 })
        await page.goto(svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
        const selector = 'svg'
        await page.waitForSelector(selector, { timeout: PAGE_TIMEOUT })
        const element = await page.$(selector)
        const buffer = await element.screenshot({ printBackground: false })
        res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
        res.send(buffer)
      } finally {
        await releasePage(page, entry)
        releaseRenderSlot()
      }
    } else {
      res.status(400).send('No data from the server')
    }
  } catch (err) {
    logError(err)
    if (err.message && err.message.includes('queue timeout')) {
      return res.status(503).send({ error: 'Service is overloaded, please retry later' })
    }
    res.status((err && err.response && err.response.status) || 500).send(
      (err && err.response && err.response.data) || {
        error: unknownError,
      }
    )
  }
})

app.get('/public/v8/milestone/cert/download/:certId', async (req, res) => {
  try {
    const certId = req.params.certId
    logInfo('Milestone cert download - certId:', certId)

    const response = await axios.get(
      API_END_POINTS.downloadMilestoneCert(certId),
      { ...axiosRequestConfigVeryLong }
    )

    const svgContent = response?.data?.result?.printUri

    if (!svgContent) {
      return res.status(400).send('printUri not received from backend')
    }

    await acquireRenderSlot()
    let page = null
    let entry = null
    try {
      const acquired = await acquirePage()
      page = acquired.page
      entry = acquired.entry
      await page.setViewport({ width: 1920, height: 1080 })
      await page.goto(svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
      const selector = 'svg'
      await page.waitForSelector(selector, { timeout: PAGE_TIMEOUT })
      const element = await page.$(selector)
      const buffer = await element.screenshot({ printBackground: false })
      res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
      res.send(buffer)
    } finally {
      await releasePage(page, entry)
      releaseRenderSlot()
    }
  } catch (err) {
    logError(err)
    if (err.message && err.message.includes('queue timeout')) {
      return res.status(503).send({ error: 'Service is overloaded, please retry later' })
    }
    res.status(500).send('Failed to generate milestone certificate')
  }
})

// Pre-launch browser pool at startup
initBrowserPool().then(() => {
  logInfo(`Browser pool ready: ${BROWSER_POOL_SIZE} browsers, ${MAX_PAGES_PER_BROWSER} pages each, ${MAX_CONCURRENT_RENDERS} total capacity`)
}).catch((err) => {
  logError('Failed to init browser pool:', err)
})

// Graceful shutdown
async function shutdown() {
  logInfo('Shutting down...')
  for (const entry of browserPool) {
    try { await entry.browser.close() } catch (_) {}
  }
  browserPool.length = 0
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

app.listen(port, () => {
  return console.log(`Express is listening at http://localhost:${port}`)
})
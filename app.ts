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
const BROWSER_POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE) || 5
const MAX_PAGES_PER_BROWSER = Number(process.env.MAX_PAGES_PER_BROWSER) || 4
const MAX_CONCURRENT_RENDERS = BROWSER_POOL_SIZE * MAX_PAGES_PER_BROWSER
const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 30000
const QUEUE_TIMEOUT = Number(process.env.QUEUE_TIMEOUT) || 60000

const API_END_POINTS = {
  downloadCert: (certId: string) => `http://cert-registry-service:9000/certs/v2/registry/download/${certId}`,
  downloadMilestoneCert: (certId) =>
    `http://certificate-generator-service:9000/v1/public/milestone/achievement/download/${certId}`
}

// --- Browser pool: multiple Chromium processes to avoid single-process bottleneck ---
const browserPool: Array<{ browser: any; activePages: number }> = []
let poolReady = false

const BROWSER_LAUNCH_OPTIONS = {
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
}

async function createBrowserEntry(): Promise<{ browser: any; activePages: number }> {
  const browser = await puppeteer.launch(BROWSER_LAUNCH_OPTIONS)
  const entry = { browser, activePages: 0 }
  browser.on('disconnected', () => {
    logInfo('A browser instance disconnected, removing from pool')
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
  poolReady = true
}

async function acquirePage(): Promise<{ page: any; entry: { browser: any; activePages: number } }> {
  // Ensure pool has enough browsers (replenish if any crashed)
  while (browserPool.length < BROWSER_POOL_SIZE) {
    try {
      const entry = await createBrowserEntry()
      browserPool.push(entry)
      logInfo('Replenished crashed browser, pool size:', String(browserPool.length))
    } catch (err) {
      logError('Failed to replenish browser:', err)
      break
    }
  }
  // Pick the browser with the fewest active pages
  const entry = browserPool.reduce((a, b) => a.activePages <= b.activePages ? a : b)
  if (entry.activePages >= MAX_PAGES_PER_BROWSER) {
    throw new Error('All browser slots full')
  }
  entry.activePages++
  const page = await entry.browser.newPage()
  return { page, entry }
}

function releasePage(page: any, entry: { browser: any; activePages: number }) {
  entry.activePages = Math.max(0, entry.activePages - 1)
  if (page) {
    try { page.close() } catch (_) {}
  }
}

// --- Concurrency limiter: prevents OOM by capping parallel renders ---
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
        releasePage(page, entry)
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
        releasePage(page, entry)
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
        releasePage(page, entry)
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
      releasePage(page, entry)
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
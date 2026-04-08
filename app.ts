import express from 'express'
import { logError, logInfo } from './utils/logger'
import axios from 'axios'
import { axiosRequestConfig, axiosRequestConfigVeryLong } from './configs/request.config'
import { Cluster } from 'puppeteer-cluster'

const app = express()
const port = 3000
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb' }))

const unknownError = 'Failed due to unknown reason'
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || 30
const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 30000
const QUEUE_TIMEOUT = Number(process.env.QUEUE_TIMEOUT) || 60000
const RETRY_LIMIT = Number(process.env.RETRY_LIMIT) || 1

const API_END_POINTS = {
  downloadCert: (certId: string) => `http://cert-registry-service:9000/certs/v2/registry/download/${certId}`,
  downloadMilestoneCert: (certId) =>
    `http://certificate-generator-service:9000/v1/public/milestone/achievement/download/${certId}`
}

// --- Puppeteer Cluster: manages browser pool, concurrency, queuing, and crash recovery ---
let cluster: Cluster | null = null

async function initCluster() {
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: MAX_CONCURRENCY,
    timeout: PAGE_TIMEOUT + 10000,
    retryLimit: RETRY_LIMIT,
    puppeteerOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    } as any,
    monitor: false,
  })
  logInfo(`Cluster launched: CONCURRENCY_CONTEXT, maxConcurrency=${MAX_CONCURRENCY}, retryLimit=${RETRY_LIMIT}`)
}

// Task handlers for the cluster
async function renderPdf({ page, data }: { page: any; data: { svgContent: string } }): Promise<Buffer> {
  await page.goto(data.svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
  return await page.pdf({ printBackground: true, width: '1204px', height: '662px' })
}

async function renderPng({ page, data }: { page: any; data: { svgContent: string; viewport?: { width: number; height: number } } }): Promise<Buffer> {
  if (data.viewport) {
    await page.setViewport(data.viewport)
  }
  await page.goto(data.svgContent, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
  const selector = 'svg'
  await page.waitForSelector(selector, { timeout: PAGE_TIMEOUT })
  const element = await page.$(selector)
  return await element.screenshot({ printBackground: false })
}

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.get('/liveness', (req, res) => {
  res.status(200).send('ok')
})

app.get('/readiness', (req, res) => {
  if (!cluster) {
    return res.status(503).send('Cluster not ready')
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
      const buffer = await cluster!.execute({ svgContent }, renderPdf)
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buffer.length })
      res.send(buffer)
    } else if (req.body.outputFormat === 'png') {
      const buffer = await cluster!.execute({ svgContent }, renderPng)
      res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
      res.send(buffer)
    }
  } catch (err) {
    logError(err)
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
      const buffer = await cluster!.execute(
        { svgContent, viewport: { width: 1920, height: 1080 } },
        renderPng
      )
      res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
      res.send(buffer)
    } else {
      res.status(400).send('No data from the server')
    }
  } catch (err) {
    logError(err)
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

    const buffer = await cluster!.execute(
      { svgContent, viewport: { width: 1920, height: 1080 } },
      renderPng
    )
    res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
    res.send(buffer)
  } catch (err) {
    logError(err)
    res.status(500).send('Failed to generate milestone certificate')
  }
})

// Initialize cluster then start server
initCluster().then(() => {
  logInfo('Cluster ready')
  app.listen(port, () => {
    console.log(`Express is listening at http://localhost:${port}`)
  })
}).catch((err) => {
  logError('Failed to init cluster:', err)
  process.exit(1)
})

// Graceful shutdown
async function shutdown() {
  logInfo('Shutting down...')
  if (cluster) {
    await cluster.idle()
    await cluster.close()
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
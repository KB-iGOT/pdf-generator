import request from 'supertest'
import axios from 'axios'

// jest.mock calls are hoisted above imports, so puppeteer is mocked
// before app.ts loads and tries to use it.
jest.mock('puppeteer', () => {
  const mockElement = {
    screenshot: jest.fn().mockResolvedValue(Buffer.from('png-content')),
  }
  const mockPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockResolvedValue(Buffer.from('pdf-content')),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
    $: jest.fn().mockResolvedValue(mockElement),
    close: jest.fn().mockResolvedValue(undefined),
  }
  const mockBrowser = {
    newPage: jest.fn().mockResolvedValue(mockPage),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }
  return {
    launch: jest.fn().mockResolvedValue(mockBrowser),
    __mockPage: mockPage,
    __mockBrowser: mockBrowser,
  }
})

jest.mock('axios')

const mockedAxios = axios as jest.Mocked<typeof axios>

// Import app after mocks are set up
import { app, acquireRenderSlot, releaseRenderSlot } from './app'

// ─── Health & Root ─────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns 200 with Hello World!', async () => {
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toBe('Hello World!')
  })
})

describe('GET /liveness', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/liveness')
    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
  })
})

describe('GET /readiness', () => {
  it('returns 200 ok when service is not busy', async () => {
    const res = await request(app).get('/readiness')
    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
  })
})

// ─── Mobile cert download (SVG / PDF / PNG) ────────────────────────────────────

describe('POST /public/v8/course/batch/cert/download/mobile', () => {
  const endpoint = '/public/v8/course/batch/cert/download/mobile'

  it('returns decoded SVG as HTML for outputFormat=svg', async () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>'
    const printUri = `data:image/svg+xml,${encodeURIComponent(svgContent)}`

    const res = await request(app)
      .post(endpoint)
      .send({ printUri, outputFormat: 'svg' })

    expect(res.status).toBe(200)
    expect(res.type).toContain('html')
    expect(res.text).toContain('<svg')
  })

  it('returns a PDF buffer for outputFormat=pdf', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })

    expect(res.status).toBe(200)
    expect(res.type).toBe('application/pdf')
    expect(res.body).toBeDefined()
  })

  it('returns a PNG buffer for outputFormat=png', async () => {
    const res = await request(app)
      .post(endpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'png' })

    expect(res.status).toBe(200)
    expect(res.type).toBe('image/png')
    expect(res.body).toBeDefined()
  })

  it('returns 500 when page navigation fails', async () => {
    const { __mockPage } = jest.requireMock('puppeteer')
    __mockPage.goto.mockRejectedValueOnce(new Error('Navigation failed'))

    const res = await request(app)
      .post(endpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })

    expect(res.status).toBe(500)
  })

  it('forwards upstream HTTP status when page navigation fails with a response error', async () => {
    // Makes err.response.status and err.response.data truthy in the mobile catch block,
    // covering the binary-expr arm-2 branches on lines 226-227 of app.ts.
    const { __mockPage } = jest.requireMock('puppeteer')
    const upstreamError = Object.assign(new Error('Upstream error'), {
      response: { status: 503, data: 'Gateway timeout' },
    })
    __mockPage.goto.mockRejectedValueOnce(upstreamError)

    const res = await request(app)
      .post(endpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })

    expect(res.status).toBe(503)
  })
})

// ─── Cert download by ID ────────────────────────────────────────────────────────

describe('GET /public/v8/cert/download/:certId', () => {
  const endpoint = '/public/v8/cert/download/test-cert-123'

  it('returns PNG when backend returns a printUri', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { result: { printUri: 'http://example.com/cert.svg' } },
    } as any)

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(200)
    expect(res.type).toBe('image/png')
  })

  it('returns 400 when printUri is absent in the backend response', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { result: {} },
    } as any)

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(400)
    expect(res.text).toBe('No data from the server')
  })

  it('returns 500 when the backend call fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'))

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(500)
  })

  it('returns upstream status when backend responds with an HTTP error', async () => {
    const axiosError: any = new Error('Not found')
    axiosError.response = { status: 404, data: { message: 'cert not found' } }
    mockedAxios.get.mockRejectedValueOnce(axiosError)

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(404)
  })
})

// ─── Milestone cert download ────────────────────────────────────────────────────

describe('GET /public/v8/milestone/cert/download/:certId', () => {
  const endpoint = '/public/v8/milestone/cert/download/milestone-cert-456'

  it('returns PNG when backend returns a printUri', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { result: { printUri: 'http://example.com/milestone.svg' } },
    } as any)

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(200)
    expect(res.type).toBe('image/png')
  })

  it('returns 400 when printUri is not in the backend response', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { result: {} },
    } as any)

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(400)
    expect(res.text).toBe('printUri not received from backend')
  })

  it('returns 500 when the backend call fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Service unavailable'))

    const res = await request(app).get(endpoint)
    expect(res.status).toBe(500)
  })
})

// ─── Browser pool internals ─────────────────────────────────────────────────────

describe('browser disconnected event handler', () => {
  it('does not throw when the disconnected callback is invoked', () => {
    const { __mockBrowser } = jest.requireMock('puppeteer')
    const disconnectedCalls = (__mockBrowser.on.mock.calls as [string, () => void][])
      .filter(([event]) => event === 'disconnected')

    expect(disconnectedCalls.length).toBeGreaterThan(0)
    // Calling the callback removes the entry from the pool (or is a no-op if already recycled)
    expect(() => disconnectedCalls[0][1]()).not.toThrow()
  })
})

// ─── Concurrency / render-slot edge cases ──────────────────────────────────────

describe('render slot concurrency', () => {
  const mobileEndpoint = '/public/v8/course/batch/cert/download/mobile'
  const certEndpoint = '/public/v8/cert/download/test-cert'
  const milestoneEndpoint = '/public/v8/milestone/cert/download/test-milestone'

  it('GET /readiness returns 503 when all render slots are busy', async () => {
    await acquireRenderSlot() // occupy the single slot
    try {
      const res = await request(app).get('/readiness')
      expect(res.status).toBe(503)
      expect(res.text).toBe('Service busy')
    } finally {
      releaseRenderSlot()
    }
  })

  it('queued request is released when the slot is freed (covers releaseRenderSlot queue path)', async () => {
    await acquireRenderSlot() // hold the slot

    // Use .end() to send the HTTP request EAGERLY (supertest is lazy — it only
    // sends the request when you await/then/end it; using .end() here fires it
    // immediately so the route handler has time to call acquireRenderSlot and
    // enqueue itself before we call releaseRenderSlot below).
    const queuedReqPromise = new Promise<any>((resolve, reject) => {
      request(app)
        .post(mobileEndpoint)
        .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })
        .end((err, res) => (err ? reject(err) : resolve(res)))
    })

    // Wait for the route handler to call acquireRenderSlot and enqueue itself
    await new Promise(r => setTimeout(r, 60))
    releaseRenderSlot() // now waitQueue.length > 0 → covers lines 154-156

    const res = await queuedReqPromise
    expect(res.status).toBe(200)
  })

  it('POST mobile returns 503 when the render queue times out', async () => {
    await acquireRenderSlot() // hold the slot so the next request queues and times out
    try {
      const res = await request(app)
        .post(mobileEndpoint)
        .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })
      expect(res.status).toBe(503)
      expect(res.body.error).toContain('overloaded')
    } finally {
      releaseRenderSlot()
    }
  }, 10000)

  it('GET cert/download returns 503 when the render queue times out', async () => {
    mockedAxios.get.mockResolvedValueOnce(
      { data: { result: { printUri: 'http://example.com/c.svg' } } } as any
    )
    await acquireRenderSlot()
    try {
      const res = await request(app).get(certEndpoint)
      expect(res.status).toBe(503)
      expect(res.body.error).toContain('overloaded')
    } finally {
      releaseRenderSlot()
    }
  }, 10000)

  it('GET milestone/cert/download returns 503 when the render queue times out', async () => {
    mockedAxios.get.mockResolvedValueOnce(
      { data: { result: { printUri: 'http://example.com/m.svg' } } } as any
    )
    await acquireRenderSlot()
    try {
      const res = await request(app).get(milestoneEndpoint)
      expect(res.status).toBe(503)
    } finally {
      releaseRenderSlot()
    }
  }, 10000)
})

// ─── Browser-pool error paths ───────────────────────────────────────────────────

describe('browser pool error paths', () => {
  const mobileEndpoint = '/public/v8/course/batch/cert/download/mobile'

  afterEach(() => {
    // Safety net: release any leaked render slot so subsequent tests are clean.
    releaseRenderSlot()
  })

  // Run recycling-failure FIRST: the pool has a live entry from the concurrency
  // tests above.  After this test, recycling fails and leaves the pool EMPTY.
  it('returns 200 but logs error when launch fails during recycling (covers releasePage catch line 127)', async () => {
    // MAX_PAGES_BEFORE_RECYCLE=1 → releasePage recycles after every request.
    // Make the replacement launch() fail to exercise the catch block (line 127).
    const puppeteer = jest.requireMock('puppeteer')
    puppeteer.launch.mockRejectedValueOnce(new Error('Recycle launch failed'))

    const res = await request(app)
      .post(mobileEndpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })

    // Response is sent (200) inside the try block before releasePage recycling runs.
    expect(res.status).toBe(200)
    // Pool is now EMPTY (old entry removed, replacement failed).
  })

  // Run replenishment-failure SECOND: the pool is already empty after the test above.
  it('returns 500 when launch fails during pool replenishment (covers acquirePage catch lines 96-97)', async () => {
    // Pool is empty from the previous test.  Calling the last disconnected callback
    // is a no-op here (entry was already removed) but documents intent.
    const { __mockBrowser } = jest.requireMock('puppeteer')
    const disconnectedCalls = (__mockBrowser.on.mock.calls as [string, () => void][])
      .filter(([event]) => event === 'disconnected')
    disconnectedCalls[disconnectedCalls.length - 1][1]()

    const puppeteer = jest.requireMock('puppeteer')
    puppeteer.launch.mockRejectedValueOnce(new Error('Browser launch failed'))

    const res = await request(app)
      .post(mobileEndpoint)
      .send({ printUri: 'http://example.com/cert', outputFormat: 'pdf' })

    expect(res.status).toBe(500)
  })
})

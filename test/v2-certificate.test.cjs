const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const { once } = require('node:events')
const { test } = require('node:test')
const { inflateSync } = require('node:zlib')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'dist/app.js'), 'utf8')
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
const PRINT_URI = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="50"%3E%3C/svg%3E'

// Execute the built application with isolated I/O. The real pool/queue helpers and
// route handlers run unchanged; no production exports or bootstrap flags needed.
async function createHarness(options = {}) {
  const routes = new Map()
  const launches = []
  const pendingRequests = []
  const timers = new Set()
  const calls = { get: [], launch: [], newPage: 0, close: 0, viewport: [], goto: [], wait: [], select: [], screenshot: [], forceClose: 0, session: 0 }
  const fakePage = {
    async createCDPSession() {
      calls.session++
      fail('createCDPSession')
      return {
        async send() { fail('targetInfo'); return { targetInfo: { targetId: 'owned-page' } } },
        connection: () => ({
          async send(method, params) {
            assert.equal(method, 'Target.closeTarget')
            assert.equal(params.targetId, 'owned-page')
            calls.forceClose++
            if (options.onForceClose) options.onForceClose()
          }
        })
      }
    },
    async setViewport(value) { calls.viewport.push(value); fail('setViewport') },
    async goto(...args) { calls.goto.push(args); fail('goto') },
    async waitForSelector(...args) { calls.wait.push(args); fail('waitForSelector') },
    async $(selector) {
      calls.select.push(selector)
      fail('select')
      return options.noElement ? null : {
        async screenshot(value) {
          calls.screenshot.push(value)
          fail('screenshot')
          if (options.screenshot) return options.screenshot()
          return new Uint8Array(PNG)
        }
      }
    },
    async close() { calls.close++; fail('close'); if (options.close) await options.close() }
  }
  function fail(stage) {
    if (options.failAt === stage) throw options.error || new Error(`${stage} failed`)
  }
  const browser = {
    on() {},
    async newPage() { calls.newPage++; fail('newPage'); return options.newPage ? options.newPage() : fakePage },
    async close() {}
  }
  const express = options.realExpress || Object.assign(() => ({
    use() {}, post() {}, get() {}, listen() {}
  }), { json() {}, urlencoded() {} })
  function expressFactory() {
    const app = express()
    const get = app.get.bind(app)
    app.get = (...args) => {
      if (args.length > 1) {
        const handler = args[1]
        routes.set(args[0], handler)
        if (options.realExpress) {
          args[1] = (...requestArgs) => {
            const pending = handler(...requestArgs)
            pendingRequests.push(pending)
            return pending
          }
        }
      }
      return get(...args)
    }
    const post = app.post.bind(app)
    app.post = (route, handler) => {
      routes.set(route, handler)
      return post(route, handler)
    }
    app.listen = () => {}
    return app
  }
  expressFactory.json = express.json
  expressFactory.urlencoded = express.urlencoded
  const axios = {
    async get(...args) {
      calls.get.push(args)
      if (options.upstreamError) throw options.upstreamError
      if (options.upstream) return options.upstream(...args)
      return Object.hasOwn(options, 'response') ? options.response : { data: { result: { printUri: PRINT_URI } } }
    }
  }
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, Buffer, AbortController,
    console: { log() {} },
    process: { env: { BROWSER_POOL_SIZE: '1', MAX_PAGES_PER_BROWSER: String(options.pagesPerBrowser || 1), PAGE_TIMEOUT: String(options.pageTimeout || 1000), QUEUE_TIMEOUT: '25' }, on() {} },
    setTimeout(callback, ms) {
      const delay = ms === 50000 ? (options.workTimeout || ms) : ms === 55000 ? (options.totalTimeout || ms) : ms
      const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer) },
    setInterval() {},
    require(id) {
      if (id === 'express') return expressFactory
      if (id === 'axios') return axios
      if (id === 'puppeteer') return {
        async launch(value) {
          calls.launch.push(value)
          if (options.launchError) throw options.launchError
          const launched = options.launch ? options.launch(value) : browser
          launches.push(launched)
          return launched
        }
      }
      if (id === './utils/logger') return { logError() {}, logInfo() {} }
      if (id === './configs/request.config') return require('../dist/configs/request.config')
      throw new Error(`Unexpected module: ${id}`)
    }
  })
  vm.runInContext(source + `\nmodule.exports = {
    app,
    limits: { request: V2_REQUEST_TIMEOUT, cleanup: V2_CLEANUP_TIMEOUT },
    state: () => ({ renders: activeRenders, queued: waitQueue.length, pages: browserPool.map(entry => entry.activePages) }),
    dispose: () => Promise.all(browserPool.map(entry => entry.browser.close()))
  };`, context, { filename: 'dist/app.js' })
  await Promise.allSettled(launches)
  await new Promise(setImmediate)
  return {
    calls, options, page: fakePage, context, routes, timers, ...module.exports,
    finished: () => Promise.all(pendingRequests),
    async request(certId = 'certificate-id', route = '/public/v2/cert/download/:certId') {
      const res = {
        statusCode: 200, headers: {}, sends: 0,
        status(code) { this.statusCode = code; return this },
        set(headers) { for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = String(value); return this },
        send(body) { assert.equal(++this.sends, 1, 'only one response'); this.body = body; return this }
      }
      await routes.get(route)({ params: { certId }, body: options.body }, res)
      return res
    }
  }
}

function assertReleased(harness) {
  const state = harness.state()
  assert.equal(state.renders, 0, 'render slot released')
  assert.equal(state.queued, 0, 'no waiter left in queue')
  assert.ok(state.pages.every(count => count === 0), 'browser page reservations released')
}

function assertPng(res) {
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(res.body), 'response is a binary Node Buffer')
  assert.deepEqual(res.body.subarray(0, 8), PNG_SIGNATURE)
  assert.equal(res.headers['content-length'], String(res.body.length))
  assert.equal(res.headers['content-disposition'], undefined)
}

test('V2 encodes the ID, generates once, renders the original URI, and releases resources', async () => {
  const h = await createHarness()
  const id = 'certificate/id +?#%'
  const res = await h.request(id)
  assertPng(res)
  assert.equal(h.calls.get.length, 1)
  assert.equal(h.calls.get[0][0], `http://certificate-generator-service:9000/v1/certs/legacy/generate/${encodeURIComponent(id)}`)
  assert.equal(h.calls.get[0][1].retry, 0)
  assert.equal(h.calls.get[0][1].timeout, 20000)
  assert.equal(JSON.stringify(h.calls.viewport), JSON.stringify([{ width: 1920, height: 1080 }]))
  assert.equal(h.calls.goto[0][0], PRINT_URI)
  assert.equal(JSON.stringify(h.calls.goto[0][1]), JSON.stringify({ waitUntil: 'networkidle2', timeout: 1000 }))
  assert.equal(h.calls.wait[0][0], 'svg')
  assert.equal(h.calls.wait[0][1].timeout, 1000)
  assert.equal(h.calls.wait[0][1].signal, h.calls.get[0][1].signal)
  assert.equal(h.calls.get[0][1].maxRedirects, 0)
  assert.deepEqual(h.calls.select, ['svg'])
  assert.equal(JSON.stringify(h.calls.screenshot), JSON.stringify([{ type: 'png' }]))
  assert.equal(h.calls.newPage, 1)
  assert.equal(h.calls.close, 1)
  assertReleased(h)
})

for (const printUri of [undefined, null, '', ' \n\t', 123, {}, []]) {
  test(`invalid printUri ${JSON.stringify(printUri)} returns 502 without acquiring a page`, async () => {
    const h = await createHarness({ response: { data: { result: { printUri } } } })
    const res = await h.request()
    assert.equal(res.statusCode, 502)
    assert.equal(res.headers['content-type'], undefined)
    assert.equal(h.calls.newPage, 0)
    assert.equal(h.calls.get.length, 1)
    assertReleased(h)
  })
}

test('missing upstream response envelope fails without rendering', async () => {
  const h = await createHarness({ response: { data: {} } })
  assert.equal((await h.request()).statusCode, 502)
  assert.equal(h.calls.newPage, 0)
  assertReleased(h)
})

for (const [status, body] of [[400, { error: 'invalid certificate' }], [404, 'not found'], [503, { error: 'unavailable' }], [400, '']]) {
  test(`upstream HTTP ${status} is preserved without rendering or retry`, async () => {
    const h = await createHarness({ upstreamError: { response: { status, data: body } } })
    const res = await h.request()
    assert.equal(res.statusCode, status)
    assert.equal(res.body, body)
    assert.equal(h.calls.newPage, 0)
    assert.equal(h.calls.get.length, 1)
    assertReleased(h)
  })
}

test('upstream timeout follows existing 500 behavior and is not retried', async () => {
  const error = Object.assign(new Error('timeout exceeded'), { code: 'ECONNABORTED' })
  const h = await createHarness({ upstreamError: error })
  assert.equal((await h.request()).statusCode, 500)
  assert.equal(h.calls.get.length, 1)
  assert.equal(h.calls.newPage, 0)
  assertReleased(h)
})

for (const stage of ['createCDPSession', 'targetInfo', 'setViewport', 'goto', 'waitForSelector', 'select', 'screenshot']) {
  test(`render failure at ${stage} returns 500, closes the page, and permits recovery`, async () => {
    const h = await createHarness({ failAt: stage })
    assert.equal((await h.request()).statusCode, 500)
    assert.equal(h.calls.close, 1)
    assertReleased(h)
    h.options.failAt = undefined
    assertPng(await h.request())
    assertReleased(h)
  })
}

test('missing SVG element returns 500 and releases page and slot', async () => {
  const h = await createHarness({ noElement: true })
  assert.equal((await h.request()).statusCode, 500)
  assert.equal(h.calls.close, 1)
  assertReleased(h)
})

test('newPage failure rolls back the browser reservation and releases the render slot', async () => {
  const h = await createHarness({ failAt: 'newPage' })
  assert.equal((await h.request()).statusCode, 500)
  assert.equal(h.calls.close, 0, 'no page was acquired')
  assertReleased(h)
  h.options.failAt = undefined
  assertPng(await h.request())
  assertReleased(h)
})

test('browser launch failure returns 500 without leaking a render slot', async () => {
  const h = await createHarness({ launchError: new Error('browser unavailable') })
  assert.equal((await h.request()).statusCode, 500)
  assertReleased(h)
})

test('page close rejection still releases browser reservation and render slot', async () => {
  const h = await createHarness({ failAt: 'close' })
  assertPng(await h.request())
  assert.equal(h.calls.close, 1)
  assertReleased(h)
})

test('render slot is released even if releasePage unexpectedly throws', async () => {
  const h = await createHarness()
  vm.runInContext('releasePage = async () => { throw new Error("cleanup failed") }', h.context)
  assert.equal((await h.request()).statusCode, 500)
  assert.equal(h.state().renders, 0)
})

test('queue timeout returns 503 without releasing the active request reservation', async () => {
  const h = await createHarness()
  let finish
  let entered
  const started = new Promise(resolve => { entered = resolve })
  h.page.goto = async () => { entered(); await new Promise(resolve => { finish = resolve }) }
  const first = h.request('first')
  await started
  const second = await h.request('second')
  assert.equal(second.statusCode, 503)
  assert.equal(h.calls.newPage, 1)
  assert.equal(h.state().renders, 1)
  finish()
  assertPng(await first)
  assertReleased(h)
  assert.equal(h.calls.get.length, 2, 'one generation call per request')
})

test('a released render slot transfers to a queued V2 request', async () => {
  const h = await createHarness()
  let finish
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let navigations = 0
  h.page.goto = async () => {
    if (++navigations === 1) {
      entered()
      await new Promise(resolve => { finish = resolve })
    }
  }
  const first = h.request('first')
  await started
  const second = h.request('second')
  await new Promise(setImmediate)
  assert.equal(h.state().queued, 1)
  finish()
  assertPng(await first)
  assertPng(await second)
  assert.equal(h.calls.get.length, 2)
  assert.equal(h.calls.close, 2)
  assertReleased(h)
})

test('full browser capacity returns 503 and releases only its render slot', async () => {
  const h = await createHarness()
  vm.runInContext('browserPool[0].activePages = MAX_PAGES_PER_BROWSER', h.context)
  assert.equal((await h.request()).statusCode, 503)
  assert.equal(h.state().renders, 0)
  assert.equal(h.state().pages[0], 1, 'existing browser reservation is unchanged')
})

test('V8 still uses certificate registry, original rendering options, and existing errors', async () => {
  const h = await createHarness()
  const route = '/public/v8/cert/download/:certId'
  const res = await h.request('v8-id', route)
  assert.equal(h.calls.get[0][0], 'http://cert-registry-service:9000/certs/v2/registry/download/v8-id')
  assert.equal(h.calls.get[0][1].timeout, 10000)
  assert.equal(h.calls.goto[0][0], PRINT_URI)
  assert.equal(JSON.stringify(h.calls.screenshot), JSON.stringify([{ printBackground: false }]))
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(h.calls.close, 1)
  assertReleased(h)
  h.options.response = { data: {} }
  const missing = await h.request('v8-id', route)
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.body, 'No data from the server')
})

test('V2 reserves a 50s work budget and 5s cleanup budget without changing shared defaults', async () => {
  const h = await createHarness()
  assert.equal(h.limits.request, 55000)
  assert.equal(h.limits.cleanup, 5000)
  assertPng(await h.request())
  assert.equal(h.timers.size, 0)
})

test('V2 deadline aborts upstream once without acquiring a page', async () => {
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40, upstream: () => new Promise(() => {}) })
  const res = await h.request()
  assert.equal(res.statusCode, 504)
  assert.equal(h.calls.get.length, 1)
  assert.equal(h.calls.get[0][1].signal.aborted, true)
  assert.equal(h.calls.newPage, 0)
  assert.equal(h.timers.size, 0)
  assertReleased(h)
})

test("V2 deadline removes a queued waiter without releasing another request's slot", async () => {
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40 })
  vm.runInContext('activeRenders = MAX_CONCURRENT_RENDERS', h.context)
  assert.equal((await h.request()).statusCode, 504)
  assert.equal(h.state().queued, 0)
  assert.equal(h.state().renders, 1)
  assert.equal(h.calls.newPage, 0)
  assert.equal(h.timers.size, 0)
  vm.runInContext('releaseRenderSlot()', h.context)
  assertReleased(h)
})

test('cancelled queue transfer releases its newly acquired slot exactly once', async () => {
  const h = await createHarness()
  await vm.runInContext('acquireRenderSlot()', h.context)
  const controller = new AbortController()
  h.context.testSignal = controller.signal
  const pending = vm.runInContext('acquireRenderSlot(testSignal)', h.context)
  vm.runInContext('releaseRenderSlot()', h.context)
  controller.abort(new Error('cancel after transfer'))
  await pending
  assert.equal(h.state().renders, 1)
  vm.runInContext('releaseRenderSlot()', h.context)
  assertReleased(h)
  assert.equal(h.timers.size, 0)
})

test('late page creation is closed and accounted once after V2 timeout', async () => {
  let finish
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40,
    newPage: () => new Promise(resolve => { finish = resolve }) })
  const res = await h.request()
  assert.equal(res.statusCode, 504)
  assert.equal(h.state().renders, 0)
  assert.equal(h.state().pages[0], 1, 'retain reservation until late page is actually closed')
  assert.equal(h.calls.close, 0, 'caller never acquired a page')
  finish(h.page)
  await new Promise(setImmediate)
  assert.equal(h.calls.close, 1)
  assertReleased(h)
  assert.equal(res.sends, 1)
  assert.equal(h.timers.size, 0)
})

test('late page rejection rolls back once without closing a nonexistent page', async () => {
  let reject
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40,
    newPage: () => new Promise((resolve, fail) => { reject = fail }) })
  assert.equal((await h.request()).statusCode, 504)
  reject(new Error('late page failure'))
  await new Promise(setImmediate)
  assert.equal(h.calls.close, 0)
  assertReleased(h)
})

test('late browser replenishment is closed instead of entering the pool', async () => {
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40 })
  let finish
  let closed = 0
  vm.runInContext('browserPool.length = 0', h.context)
  h.options.launch = () => new Promise(resolve => { finish = resolve })
  assert.equal((await h.request()).statusCode, 504)
  finish({ on() {}, async close() { closed++ } })
  await new Promise(setImmediate)
  assert.equal(closed, 1)
  assert.equal(h.state().pages.length, 0)
  assertReleased(h)
})

for (const stage of ['setViewport', 'goto', 'waitForSelector', '$', 'screenshot']) {
  test(`V2 deadline cancels ${stage} and closes only its own page`, async () => {
    let finish
    const h = await createHarness({ workTimeout: 15, totalTimeout: 40 })
    const hang = () => new Promise(resolve => { finish = resolve })
    if (stage === 'screenshot') h.options.screenshot = hang
    else h.page[stage] = hang
    const res = await h.request()
    assert.equal(res.statusCode, 504)
    assert.equal(h.calls.forceClose, 1)
    assert.equal(h.calls.close, 1)
    assertReleased(h)
    finish(stage === 'screenshot' ? new Uint8Array(PNG) : undefined)
    await new Promise(setImmediate)
    assert.equal(res.sends, 1, 'late render never sends a response')
    assert.equal(h.calls.close, 1)
    assert.equal(h.timers.size, 0)
  })
}

test('V2 cleanup deadline returns 504 without reusing a page whose close is pending', async () => {
  let finish
  const h = await createHarness({ workTimeout: 15, totalTimeout: 40,
    close: () => new Promise(resolve => { finish = resolve }) })
  const res = await h.request()
  assert.equal(res.statusCode, 504)
  assert.equal(h.state().renders, 0)
  assert.equal(h.state().pages[0], 1)
  assert.equal(h.calls.close, 1)
  assert.equal(h.calls.forceClose, 1)
  finish()
  await new Promise(setImmediate)
  assertReleased(h)
  assert.equal(res.sends, 1)
  assert.equal(h.calls.close, 1)
  assert.equal(h.timers.size, 0)
})

test('newPage failure rolls back only its own reservation with another page active', async () => {
  const h = await createHarness({ failAt: 'newPage', pagesPerBrowser: 2 })
  vm.runInContext('browserPool[0].activePages = 1', h.context)
  assert.equal((await h.request()).statusCode, 500)
  assert.equal(h.state().pages[0], 1, 'exactly one rollback, not a double decrement')
  assert.equal(h.state().renders, 0)
  assert.equal(h.calls.close, 0)
})

test('V8 acquisition failure does not leak a render slot while a V2 page is still closing', async () => {
  const h = await createHarness()
  vm.runInContext('browserPool[0].activePages = MAX_PAGES_PER_BROWSER', h.context)
  assert.equal((await h.request('v8-id', '/public/v8/cert/download/:certId')).statusCode, 500)
  assert.equal(h.state().renders, 0)
  assert.equal(h.state().pages[0], 1)
  assert.equal(h.calls.close, 0)
})

test('mobile PNG and milestone routes retain their generation and rendering conventions', async () => {
  const mobile = await createHarness({ body: { printUri: PRINT_URI, outputFormat: 'png' } })
  const mobileRes = await mobile.request('unused', '/public/v8/course/batch/cert/download/mobile')
  assert.equal(mobileRes.statusCode, 200)
  assert.equal(mobileRes.headers['content-type'], 'image/png')
  assert.equal(mobile.calls.get.length, 0)
  assert.equal(mobile.calls.goto[0][0], PRINT_URI)
  assert.equal(JSON.stringify(mobile.calls.screenshot), JSON.stringify([{ printBackground: false }]))
  assertReleased(mobile)
  const milestone = await createHarness()
  const milestoneRes = await milestone.request('milestone-id', '/public/v8/milestone/cert/download/:certId')
  assert.equal(milestoneRes.statusCode, 200)
  assert.equal(milestoneRes.headers['content-type'], 'image/png')
  assert.equal(milestone.calls.get[0][0], 'http://certificate-generator-service:9000/v1/public/milestone/achievement/download/milestone-id')
  assert.equal(milestone.calls.get[0][1].timeout, 200000)
  assert.equal(milestone.calls.goto[0][0], PRINT_URI)
  assert.equal(JSON.stringify(milestone.calls.screenshot), JSON.stringify([{ printBackground: false }]))
  assertReleased(milestone)
})

// Decode Chromium's 8-bit RGB/RGBA PNG scanlines to check visible fixture pixels.
function pngPixels(png) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(png[24], 8)
  assert.ok([2, 6].includes(png[25]))
  const channels = png[25] === 6 ? 4 : 3
  const stride = width * channels
  const chunks = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter <= 4)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const corner = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      const estimate = left + up - corner
      const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : corner
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter]
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  return (x, y) => Array.from(pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3))
}

// Optional real-browser verification: uses the installed Puppeteer and a local
// Chromium, with synthetic SVG fixtures only (no DEV services or credentials).
const puppeteer = require('puppeteer')

test('real Puppeteer returns PNG over HTTP for multiple SVG templates and invalid CSS', {
  timeout: 30000
}, async t => {
  const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH ||
    [await puppeteer.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium']
      .find(file => typeof file === 'string' && fs.existsSync(file))
  if (!browserPath) return t.skip('No local Chromium available; set PUPPETEER_EXECUTABLE_PATH')
  const logo = `data:image/png;base64,${PNG.toString('base64')}`
  const fixtures = [
    { width: 400, height: 200, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><style>text { font-style: bold; }</style><rect width="400" height="200" fill="#112233"/><text x="20" y="40">Certificate of completion</text><image href="${logo}" x="20" y="60" width="40" height="40"/></svg>` },
    { width: 320, height: 180, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#ddeeff"/><text x="10" y="30">Achievement template</text><image href="${logo}" x="10" y="50" width="32" height="32"/><g transform="translate(200,80)"><rect width="60" height="60" fill="white"/><path d="M0 0h20v20H0z M40 0h20v20H40z M0 40h20v20H0z M30 30h10v10H30z"/></g></svg>` }
  ]
  let realBrowser
  const h = await createHarness({
    realExpress: require('express'),
    pageTimeout: 5000,
    launch: async config => {
      realBrowser = await puppeteer.launch({ ...config, executablePath: browserPath })
      return realBrowser
    }
  })
  t.after(() => h.dispose())
  const server = http.createServer(h.app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
  for (const fixture of fixtures) {
    // Match the generator's partial encoding; preserve literal '+' in base64.
    const encodedSvg = fixture.svg.replace(/[<>#%"]/g, char => ({ '<': '%3C', '>': '%3E', '#': '%23', '%': '%25', '"': "'" })[char])
    const printUri = `data:image/svg+xml,${encodedSvg}`
    h.options.response = { data: { result: { printUri } } }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/public/v2/cert/download/browser-fixture`)
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('content-length'), String(body.length))
    assert.equal(response.headers.get('content-disposition'), null)
    assert.deepEqual(body.subarray(0, 8), PNG_SIGNATURE)
    assert.equal(body.toString('ascii', 12, 16), 'IHDR')
    assert.equal(body.readUInt32BE(16), fixture.width, 'captures SVG, not viewport')
    assert.equal(body.readUInt32BE(20), fixture.height)
    const pixel = pngPixels(body)
    if (fixture.width === 400) {
      assert.deepEqual(pixel(1, 1), [17, 34, 51])
      assert.deepEqual(pixel(30, 70), [255, 255, 255], 'embedded PNG logo is visible')
    } else {
      assert.deepEqual(pixel(1, 1), [221, 238, 255])
      assert.deepEqual(pixel(20, 60), [255, 255, 255], 'embedded PNG logo is visible')
      assert.deepEqual(pixel(205, 85), [0, 0, 0], 'QR-style pattern is visible')
      assert.deepEqual(pixel(225, 85), [255, 255, 255])
    }
    // HTTP bytes can arrive before the handler finishes its async finally.
    await h.finished()
    assertReleased(h)
  }
  assert.equal(h.calls.get.length, fixtures.length)
  await t.test('deadline closes the owned Chromium target without killing the shared browser', async () => {
    const previousPages = await realBrowser.pages()
    const newPage = realBrowser.newPage.bind(realBrowser)
    realBrowser.newPage = async () => {
      const page = await newPage()
      page.goto = () => new Promise(() => {})
      return page
    }
    h.options.workTimeout = 500
    h.options.totalTimeout = 1500
    assert.equal((await h.request()).statusCode, 504)
    assert.equal(realBrowser.connected, true)
    assert.equal((await realBrowser.pages()).length, previousPages.length)
    assert.ok(previousPages.every(page => !page.isClosed()), 'unrelated tabs remain alive')
    assertReleased(h)
    assert.equal(h.calls.get.length, fixtures.length + 1)
  })
})

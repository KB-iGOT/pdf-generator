// Limit browser/page pool sizes so tests don't spin up many browsers
process.env.BROWSER_POOL_SIZE = '1'
process.env.MAX_PAGES_PER_BROWSER = '1'
process.env.MAX_PAGES_BEFORE_RECYCLE = '1'
process.env.PAGE_TIMEOUT = '5000'
process.env.QUEUE_TIMEOUT = '100'

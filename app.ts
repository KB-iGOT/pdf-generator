import express from 'express';
import { v4 as uuidv4 } from 'uuid'
import { logError, logInfo } from './utils/logger'
import * as fs from 'fs'
const app = express();
const port = 3000;
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb'}))

const puppeteer = require('puppeteer')

app.get('/', (req, res) => {
  res.send('Hello World!')
});

app.listen(port, () => {
  return console.log(`Express is listening at http://localhost:${port}`);
});

app.post('/public/v8/course/batch/cert/download/mobile', async (req, res) => {
  try {
    const svgContent = req.body.printUri
    if (req.body.outputFormat === 'svg') {
      const _decodedSvg = decodeURIComponent(svgContent.replace(/data:image\/svg\+xml,/, '')).replace(/\<!--\s*[a-zA-Z0-9\-]*\s*--\>/g, '')
      res.type('html')
      res.status(200).send(_decodedSvg)
    } else if (req.body.outputFormat === 'pdf') {
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
      const page = await browser.newPage()
      await page.goto(svgContent, { waitUntil: 'networkidle2' })
      const uuid = uuidv4()
      const buffer = await page.pdf({ path: `certificates/certificate-${uuid}.pdf`, printBackground: true, width: '1204px', height: '662px' })
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buffer.length })
      res.send(buffer)
      browser.close()
      fs.unlink(`certificates/certificate-${uuid}.pdf`, function(){
        logInfo('Deleted file : ', `certificates/certificate-${uuid}.pdf`)
      });
    }  else if (req.body.outputFormat === 'png') {
      // Puppeteer implementation
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
      const page = await browser.newPage()
      await page.goto(svgContent, { waitUntil: 'networkidle2' })
      const uuid = uuidv4()
      const buffer = await page.screenshot({ path: `certificates/certificate-${uuid}.png`, printBackground: true, width: '1204px', height: '662px' })
      res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length })
      res.send(buffer)
      browser.close()
      // fs.unlink(`certificates/certificate-${uuid}.png`, function(){
      //   logInfo('Deleted file : ', `certificates/certificate-${uuid}.png`)
      // });
    }
  }
  catch (err) {
    logError(err)

    res.status((err && err.response && err.response.status) || 500).send(
      (err && err.response && err.response.data) || {
        error: 'Failed due to unknown reason',
      }
    )
  }
})

app.listen(3002);
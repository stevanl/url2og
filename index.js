#!/usr/bin/env node

import express from 'express';
import puppeteer from 'puppeteer';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const app = express();
const PORT = process.env.PORT || 4040;

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'url2og';
const CDN_DOMAIN = process.env.CDN_DOMAIN || 'cdn.currencytransfer.com';

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// Settings
const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '3000');
const MAX_HEIGHT = parseInt(process.env.MAX_HEIGHT || '3000');
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '10');
const CACHE_TTL_DAYS = parseInt(process.env.CACHE_TTL_DAYS || '7');

// Domain whitelist - only these domains can be screenshotted
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS
  ? process.env.ALLOWED_DOMAINS.split(',').map(d => d.trim())
  : [
      'currencytransfer.com',
      'mycurrencytransfer.com',
      'mytravelmoney.co.uk',
      'payplexo.com',
    ];
const DEV_MODE = process.env.DEV_MODE === 'true';

let activeRequests = 0;
let browser = null;
let browserQueue = [];
let isBrowserInitializing = false;
let isShuttingDown = false;

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Rate limiting
app.use((req, res, next) => {
  if (isShuttingDown) {
    return res.status(503).send('Server is shutting down');
  }
  if (browserQueue.length >= MAX_CONCURRENT_REQUESTS) {
    return res.status(429).send('Too many requests');
  }
  next();
});

function isDomainAllowed(url) {
  if (DEV_MODE) return true;
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some(allowed =>
      domain === allowed || domain.endsWith('.' + allowed)
    );
  } catch {
    return false;
  }
}

function generateCacheKey(url, width, height) {
  return crypto.createHash('md5').update(`${url}-${width}-${height}`).digest('hex');
}

async function checkR2Cache(key, ttlDays = CACHE_TTL_DAYS) {
  try {
    const response = await s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const lastModified = response.LastModified;
    if (!lastModified) return { exists: false };

    const ageMs = Date.now() - lastModified.getTime();
    const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000;

    if (ageMs > maxAgeMs) {
      console.log(`Cache expired: ${key} (${Math.floor(ageMs / 86400000)} days old, ttl: ${ttlDays}d)`);
      return { exists: false, expired: true };
    }

    return { exists: true };
  } catch {
    return { exists: false };
  }
}

async function uploadToR2(key, buffer) {
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
    CacheControl: 'public, max-age=31536000',
  }));
}

async function initBrowser() {
  if (browser) return browser;
  if (isBrowserInitializing) {
    while (isBrowserInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return browser;
  }

  isBrowserInitializing = true;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
        '--force-color-profile=srgb',
      ],
    });
    console.log('Browser initialized');
    return browser;
  } finally {
    isBrowserInitializing = false;
  }
}

async function captureScreenshot(targetUrl, width, height) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(30000);

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (isShuttingDown) {
        req.abort();
        return;
      }
      const type = req.resourceType();
      // Only block media and websocket, allow fonts for icons
      if (['media', 'websocket'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Inject CSS to remove focus outlines only
    await page.addStyleTag({
      content: `
        *:focus, *:focus-visible {
          outline: none !important;
        }
        *::-moz-focus-inner {
          border: 0 !important;
        }
      `
    });

    // Click body to clear any focused elements
    await page.click('body').catch(() => {});

    // Small wait for any CSS transitions to settle
    await new Promise(r => setTimeout(r, 100));

    const screenshot = await page.screenshot({ type: 'png' });
    return screenshot;
  } finally {
    await page.close();
  }
}

async function processRequest(targetUrl, width, height, res, skipCache = false, customTtlDays = null) {
  const cacheKey = generateCacheKey(targetUrl, width, height);
  const r2Key = `${cacheKey}.png`;
  const cdnUrl = `https://${CDN_DOMAIN}/${r2Key}`;
  const ttlDays = customTtlDays || CACHE_TTL_DAYS;

  try {
    // Check cache unless nocache param is set
    if (!skipCache) {
      const cache = await checkR2Cache(r2Key, ttlDays);
      if (cache.exists) {
        console.log(`Cache hit: ${targetUrl}`);
        return res.redirect(302, cdnUrl);
      }
      console.log(`${cache.expired ? 'Cache expired' : 'Cache miss'}: ${targetUrl} at ${width}x${height}`);
    } else {
      console.log(`No-cache request: ${targetUrl} at ${width}x${height}`);
    }

    const screenshot = await captureScreenshot(targetUrl, width, height);

    // Upload to R2 (replaces if exists)
    await uploadToR2(r2Key, screenshot);
    console.log(`Uploaded: ${r2Key}`);

    // Redirect to CDN
    res.redirect(302, cdnUrl);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    res.status(500).send('Error capturing screenshot');
  }
}

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', async (req, res) => {
  const { url, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, nocache, ttl } = req.query;
  const skipCache = nocache === '1' || nocache === 'true';
  const customTtlDays = ttl ? parseInt(ttl) : null;

  if (!url) {
    return res.send(`<!DOCTYPE html>
<html>
<head>
  <title>OG Image Service</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    .example { background: #f9f9f9; padding: 15px; border-left: 3px solid #0066cc; margin: 15px 0; }
    .domains { background: #e8f4e8; padding: 15px; border-radius: 4px; margin: 15px 0; }
  </style>
</head>
<body>
  <h1>OG Image Service</h1>
  <p>Generate OpenGraph screenshots from URLs.</p>

  <div class="domains">
    <strong>Allowed domains:</strong><br>
    ${ALLOWED_DOMAINS.map(d => `<code>${d}</code>`).join(', ')}
  </div>

  <h2>Usage</h2>
  <div class="example">
    <code>/?url=https://example.com</code><br><br>
    <code>/?url=https://example.com&width=1280&height=720</code>
  </div>

  <p>Default: ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT} PNG</p>
</body>
</html>`);
  }

  let parsedWidth = parseInt(width);
  let parsedHeight = parseInt(height);

  if (isNaN(parsedWidth) || parsedWidth < 50) parsedWidth = DEFAULT_WIDTH;
  if (isNaN(parsedHeight) || parsedHeight < 50) parsedHeight = DEFAULT_HEIGHT;
  if (parsedWidth > MAX_WIDTH) parsedWidth = MAX_WIDTH;
  if (parsedHeight > MAX_HEIGHT) parsedHeight = MAX_HEIGHT;

  let targetUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    targetUrl = `https://${url}`;
  }

  if (/[\u0000-\u001F\u007F-\u009F]/.test(targetUrl) || targetUrl.length > 2000) {
    return res.status(400).send('Invalid URL');
  }

  if (!isDomainAllowed(targetUrl)) {
    return res.status(403).send('Domain not allowed');
  }

  await processRequest(targetUrl, parsedWidth, parsedHeight, res, skipCache, customTtlDays);
});

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received, shutting down...`);

  setTimeout(() => process.exit(1), 10000);

  try {
    browserQueue.length = 0;
    if (browser) {
      await browser.close();
      browser = null;
    }
    console.log('Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (DEV_MODE) {
    console.log('DEV_MODE: All domains allowed');
  } else {
    console.log(`Allowed domains: ${ALLOWED_DOMAINS.join(', ')}`);
  }
});

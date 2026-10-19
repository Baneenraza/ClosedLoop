'use strict';

require('./load-env.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getVerdict } = require('./verdict.js');
const { getImageVerdict } = require('./image-verdict.js');
const { getVideoVerdict } = require('./video-verdict.js');
const { startFeedRefresh } = require('./link-check.js');
const { report } = require('./community.js');
const db = require('./db.js');
const { clientIp: realClientIp } = require('./client-ip.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 18 * 1024 * 1024;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ponytail: in-memory fixed window — resets on restart and is per-instance, fine for a single free-tier box.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function clientIp(req) {
  return realClientIp(req.headers, req.socket.remoteAddress);
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  return ++entry.count > RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (now - entry.start > RATE_WINDOW_MS) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && req.url.startsWith('/api/') && rateLimited(req)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'too many requests' }));
  }

  if (req.method === 'POST' && req.url === '/api/check') {
    readBody(req, 100000)
      .then(async (body) => {
        try {
          const { input, kind } = JSON.parse(body);
          if (!input || typeof input !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'input required' }));
          }
          const verdict = await getVerdict(input.slice(0, 2000), kind);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(verdict));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      })
      .catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/report') {
    readBody(req, 10000)
      .then(async (body) => {
        let result;
        try {
          const { input, deviceId } = JSON.parse(body) || {};
          result = await report(input, deviceId, clientIp(req));
        } catch (err) {
          result = { status: 400, body: { error: 'nothing to report' } };
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      })
      .catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/check-image') {
    readBody(req, MAX_IMAGE_BYTES)
      .then(async (body) => {
        try {
          const { imageBase64, mimeType } = JSON.parse(body);
          if (!imageBase64 || typeof imageBase64 !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'imageBase64 required' }));
          }
          const verdict = await getImageVerdict(imageBase64, mimeType || 'image/jpeg');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(verdict));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      })
      .catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'image too large' }));
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/check-video') {
    readBody(req, MAX_VIDEO_BYTES)
      .then(async (body) => {
        try {
          const { videoBase64, mimeType } = JSON.parse(body);
          if (!videoBase64 || typeof videoBase64 !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'videoBase64 required' }));
          }
          const verdict = await getVideoVerdict(videoBase64, mimeType || 'video/mp4');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(verdict));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      })
      .catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'video too large' }));
      });
    return;
  }

  const rawPath = req.url.split('?')[0];
  const urlPath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

startFeedRefresh();
db.ensureSchema();

server.listen(PORT, () => {
  if (!process.env.GROQ_API_KEY) {
    console.log('WARNING: GROQ_API_KEY not set — verdicts will fall back to a generic caution response.');
  }
  if (!process.env.GEMINI_API_KEY) {
    console.log('WARNING: GEMINI_API_KEY not set — image/video checks will fall back to a generic caution response.');
  }
  if (!db.enabled()) {
    console.log('WARNING: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — community reports are disabled.');
  }
  console.log(`Loop running at http://localhost:${PORT}`);
});

'use strict';
// Minimal local server that mimics the netlify.toml routing so the gallery
// function can be previewed without the Netlify CLI.
const http = require('http');
const { URL } = require('url');
const { handler } = require('../netlify/functions/gallery.js');

const PORT = process.env.PORT || 8888;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = Object.fromEntries(url.searchParams.entries());

  // Replicate: /galleries/:client  and  /galleries/:client/:file
  const m = url.pathname.match(/^\/galleries\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /galleries/crowther-key?token=abc-123');
    return;
  }
  qs.client = decodeURIComponent(m[1]);
  if (m[2]) qs.file = decodeURIComponent(m[2]);

  const result = await handler({ queryStringParameters: qs });
  const body = result.isBase64Encoded
    ? Buffer.from(result.body, 'base64')
    : result.body;
  res.writeHead(result.statusCode, result.headers);
  res.end(body);
});

server.listen(PORT, () => console.log(`Local gallery on http://localhost:${PORT}`));

'use strict';
// Minimal local server that mimics the netlify.toml routing so the gallery
// function can be previewed/tested without the Netlify CLI. Supports GET/POST,
// cookies and Set-Cookie so the password-login flow can be exercised.
const http = require('http');
const { URL } = require('url');
const { handler } = require('../netlify/functions/gallery.js');

const PORT = process.env.PORT || 8888;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = Object.fromEntries(url.searchParams.entries());

  if (!url.pathname.startsWith('/galleries/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /galleries/crowther-key');
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      queryStringParameters: qs,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false
    };
    const result = await handler(event);
    const headers = Object.assign({}, result.headers);
    // http.ServerResponse handles Set-Cookie fine as a single string here.
    const body = result.isBase64Encoded
      ? Buffer.from(result.body, 'base64')
      : result.body || '';
    res.writeHead(result.statusCode, headers);
    res.end(body);
  });
});

server.listen(PORT, () => console.log(`Local gallery on http://localhost:${PORT}`));

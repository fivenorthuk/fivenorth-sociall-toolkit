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

  // Replicate the netlify.toml rewrite: /galleries/* forwards the path
  // segments to the function, which reads client/file from event.path.
  if (!url.pathname.startsWith('/galleries/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /galleries/crowther-key?token=abc-123');
    return;
  }

  const result = await handler({ path: url.pathname, queryStringParameters: qs });
  const body = result.isBase64Encoded
    ? Buffer.from(result.body, 'base64')
    : result.body;
  res.writeHead(result.statusCode, result.headers);
  res.end(body);
});

server.listen(PORT, () => console.log(`Local gallery on http://localhost:${PORT}`));

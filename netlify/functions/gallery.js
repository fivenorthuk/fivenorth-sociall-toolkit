'use strict';

/**
 * Client gallery serverless function.
 *
 * Responsibilities:
 *   1. Authenticate a client using a token passed in the query string
 *      (e.g. /galleries/crowther-key?token=abc-123).
 *   2. Serve image galleries from a per-client folder
 *      (galleries/<client-name>/...).
 *   3. Return 403 when the supplied token does not match the requested
 *      gallery folder.
 *   4. Render a basic HTML gallery of thumbnails, and stream full-resolution
 *      originals for download.
 *
 * Every image byte is served *through* this function, so the token check is
 * enforced on the gallery page, on each thumbnail, and on each download. The
 * raw galleries/ folder is bundled with the function (see netlify.toml
 * `included_files`) and is never exposed as a public static asset.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// sharp is used for thumbnail generation. If it is unavailable for any reason
// we fall back to serving the original image, so the gallery still works.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('sharp not available, thumbnails will fall back to originals:', err.message);
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const THUMB_WIDTH = 400; // px, longest edge for gallery thumbnails

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
};

/**
 * Locate the galleries/ directory. Depending on how Netlify bundles the
 * function the working directory differs, so probe a few sensible candidates.
 */
function resolveGalleriesRoot() {
  const candidates = [
    path.join(process.cwd(), 'galleries'),
    path.join(__dirname, 'galleries'),
    path.join(__dirname, '..', '..', 'galleries'),
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, 'galleries') : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch (_) {
      /* keep probing */
    }
  }
  // Default; callers handle the missing-directory case gracefully.
  return candidates[0];
}

/**
 * Load the client -> token map.
 *
 * Preference order:
 *   1. CLIENT_TOKENS environment variable containing JSON, e.g.
 *      {"crowther-key":"abc-123","acme-co":"xyz-789"}
 *   2. clients.json config file at the project root.
 */
function loadClientTokens() {
  if (process.env.CLIENT_TOKENS) {
    try {
      return JSON.parse(process.env.CLIENT_TOKENS);
    } catch (err) {
      console.error('CLIENT_TOKENS is not valid JSON:', err.message);
      return {};
    }
  }

  const candidates = [
    path.join(process.cwd(), 'clients.json'),
    path.join(__dirname, 'clients.json'),
    path.join(__dirname, '..', '..', 'clients.json'),
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, 'clients.json') : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
    } catch (err) {
      console.error(`Failed to read ${candidate}:`, err.message);
    }
  }
  return {};
}

/**
 * Restrict a client slug to safe characters, preventing path traversal.
 * Returns null if the value is unusable.
 */
function sanitizeClient(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Restrict a filename to a bare, safe file (no directories, no traversal).
 * Returns null if the value is unusable.
 */
function sanitizeFilename(value) {
  if (!value || typeof value !== 'string') return null;
  // Reject anything with path separators or parent references outright.
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  const base = path.basename(value);
  if (base !== value) return null;
  if (!IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) return null;
  return base;
}

/**
 * Extract the client slug and (optional) filename from the request path.
 *
 * Netlify does NOT substitute redirect placeholders (`:client`) inside a
 * destination query string, so we cannot rely on `?client=:client`. Instead
 * the netlify.toml rewrite forwards the original path segments to the
 * function and we read them here. This handles both the original request
 * path (`/galleries/crowther-key/image1.png`) and the rewritten function
 * path (`/.netlify/functions/gallery/crowther-key/image1.png`).
 *
 * Returns { client, file } where each may be undefined.
 */
function parsePath(event) {
  const raw = event.path || (event.rawUrl ? new URL(event.rawUrl).pathname : '') || '';
  const stripped = raw
    .replace(/^\/\.netlify\/functions\/gallery/, '')
    .replace(/^\/galleries/, '');
  const segments = stripped.split('/').filter(Boolean);
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  };
  return {
    client: segments[0] ? decode(segments[0]) : undefined,
    file: segments[1] ? decode(segments[1]) : undefined
  };
}

/** Constant-time token comparison. */
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function listImages(galleryDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(galleryDir);
  } catch (_) {
    return [];
  }
  return entries
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .filter((name) => {
      try {
        return fs.statSync(path.join(galleryDir, name)).isFile();
      } catch (_) {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function textResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    body: message
  };
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: html
  };
}

function renderGalleryPage(client, token, images) {
  const encodedToken = encodeURIComponent(token);
  const encodedClient = encodeURIComponent(client);

  const cards = images
    .map((name) => {
      const encodedFile = encodeURIComponent(name);
      const base = `/galleries/${encodedClient}?token=${encodedToken}&file=${encodedFile}`;
      const thumbUrl = `${base}&mode=thumb`;
      const fullUrl = `${base}&mode=full`;
      const downloadUrl = `${base}&mode=download`;
      return `
        <figure class="card">
          <a href="${fullUrl}" target="_blank" rel="noopener">
            <img src="${thumbUrl}" alt="${escapeHtml(name)}" loading="lazy" />
          </a>
          <figcaption>
            <span class="filename" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <a class="download" href="${downloadUrl}">Download</a>
          </figcaption>
        </figure>`;
    })
    .join('\n');

  const empty = `<p class="empty">No images have been added to this gallery yet.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(client)} — Gallery</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f1115;
      color: #e8eaed;
    }
    header {
      padding: 24px 32px;
      border-bottom: 1px solid #23262d;
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }
    header h1 { font-size: 20px; margin: 0; font-weight: 600; }
    header .meta { color: #9aa0a6; font-size: 14px; }
    main { padding: 24px 32px 64px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 20px;
    }
    .card {
      margin: 0;
      background: #171a20;
      border: 1px solid #23262d;
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .card a { display: block; line-height: 0; }
    .card img {
      width: 100%;
      height: 200px;
      object-fit: cover;
      background: #23262d;
      transition: opacity 0.2s ease;
    }
    .card img:hover { opacity: 0.9; }
    figcaption {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.4;
    }
    .filename {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #c7cbd1;
    }
    .download {
      flex: none;
      color: #7cb0ff;
      text-decoration: none;
      font-weight: 600;
    }
    .download:hover { text-decoration: underline; }
    .empty { color: #9aa0a6; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(client)}</h1>
    <span class="meta">${images.length} image${images.length === 1 ? '' : 's'}</span>
  </header>
  <main>
    ${images.length ? `<div class="grid">${cards}</div>` : empty}
  </main>
</body>
</html>`;
}

async function serveImage(filePath, mode, filename) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  // Thumbnail: resize with sharp when available, otherwise serve the original.
  if (mode === 'thumb' && sharp) {
    try {
      const buffer = await sharp(filePath)
        .rotate() // respect EXIF orientation
        .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=3600'
        },
        body: buffer.toString('base64'),
        isBase64Encoded: true
      };
    } catch (err) {
      console.warn('Thumbnail generation failed, serving original:', err.message);
      // fall through to original
    }
  }

  const buffer = fs.readFileSync(filePath);
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=3600'
  };
  if (mode === 'download') {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }
  return {
    statusCode: 200,
    headers,
    body: buffer.toString('base64'),
    isBase64Encoded: true
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  // The client and filename come from the URL path (see parsePath), falling
  // back to query parameters for direct function invocation / local testing.
  const fromPath = parsePath(event);
  const clientRaw = params.client || fromPath.client;
  const fileRaw = params.file || fromPath.file;

  const client = sanitizeClient(clientRaw);
  const token = typeof params.token === 'string' ? params.token : '';
  const file = fileRaw ? sanitizeFilename(fileRaw) : null;
  const mode = ['thumb', 'full', 'download'].includes(params.mode) ? params.mode : 'full';

  if (!client) {
    return textResponse(400, 'Bad request: missing or invalid client name.');
  }

  // If a file was requested but failed sanitisation, reject it.
  if (fileRaw && !file) {
    return textResponse(400, 'Bad request: invalid file name.');
  }

  const tokens = loadClientTokens();
  const expectedToken = tokens[client];

  // Do not reveal whether the client exists: any auth failure is a 403.
  if (!expectedToken || !tokensMatch(token, expectedToken)) {
    return textResponse(403, 'Forbidden: the token does not grant access to this gallery.');
  }

  const galleriesRoot = resolveGalleriesRoot();
  const galleryDir = path.join(galleriesRoot, client);

  // Defence in depth: ensure the resolved directory stays inside the root.
  if (path.relative(galleriesRoot, galleryDir).startsWith('..')) {
    return textResponse(403, 'Forbidden.');
  }

  // Serving a single image.
  if (file) {
    const filePath = path.join(galleryDir, file);
    if (path.relative(galleryDir, filePath).startsWith('..')) {
      return textResponse(403, 'Forbidden.');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return textResponse(404, 'Image not found.');
    }
    return serveImage(filePath, mode, file);
  }

  // Otherwise render the gallery HTML page.
  const images = listImages(galleryDir);
  return htmlResponse(200, renderGalleryPage(client, token, images));
};

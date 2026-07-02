'use strict';

/**
 * Client gallery serverless function.
 *
 * Responsibilities:
 *   1. Authenticate a client with a per-client PASSWORD via a login page.
 *      A successful login sets a signed, HttpOnly session cookie scoped to
 *      that client's gallery; no secret ever appears in the URL. (A ?token=
 *      query still works as an alternative for direct links / testing.)
 *   2. Serve image galleries from a per-client folder (galleries/<slug>/...)
 *      with a human-friendly display name (e.g. "Crowther Key").
 *   3. Return 403 when a request is not authenticated for the gallery.
 *   4. Render an HTML gallery of thumbnails, and offer each photo as a
 *      full-size original download AND a generated web-quality download.
 *
 * Every image byte is served *through* this function, so auth is enforced on
 * the gallery page, on each thumbnail, and on each download. The raw
 * galleries/ folder and clients.json are bundled with the function (see
 * netlify.toml `included_files`) and are never exposed as public assets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// sharp powers thumbnail + web-quality resizing. If it is unavailable for any
// reason we fall back to serving the original image, so the gallery still works.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('sharp not available, resized images will fall back to originals:', err.message);
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const THUMB_WIDTH = 400; // px, longest edge for gallery thumbnails
const WEB_WIDTH = 2048; // px, longest edge for the "web quality" download
const COOKIE_NAME = 'gallery_sess';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // seconds (7 days)

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
};

/* ----------------------------- config / files ---------------------------- */

/**
 * Locate a bundled file/dir. Depending on how Netlify bundles the function the
 * working directory differs, so probe a few sensible candidates.
 */
function resolveBundled(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(__dirname, name),
    path.join(__dirname, '..', '..', name),
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, name) : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* keep probing */
    }
  }
  return candidates[0];
}

function resolveGalleriesRoot() {
  return resolveBundled('galleries');
}

/**
 * Load and normalise the client config.
 *
 * Preference order:
 *   1. CLIENT_TOKENS environment variable containing JSON.
 *   2. clients.json config file.
 *
 * Each entry may be either:
 *   "slug": "password"                         (shorthand)
 *   "slug": { "name": "Nice Name", "password": "..." }
 *
 * Returns { slug: { name, password } }.
 */
function loadClients() {
  let raw = null;
  if (process.env.CLIENT_TOKENS) {
    try {
      raw = JSON.parse(process.env.CLIENT_TOKENS);
    } catch (err) {
      console.error('CLIENT_TOKENS is not valid JSON:', err.message);
    }
  }
  if (!raw) {
    const file = resolveBundled('clients.json');
    try {
      if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`Failed to read ${file}:`, err.message);
    }
  }
  raw = raw || {};

  const out = {};
  for (const [slug, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[slug] = { name: prettifySlug(slug), password: value };
    } else if (value && typeof value === 'object') {
      out[slug] = {
        name: value.name || prettifySlug(slug),
        password: value.password != null ? String(value.password) : ''
      };
    }
  }
  return out;
}

function prettifySlug(slug) {
  return String(slug)
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ------------------------------ sanitising -------------------------------- */

function sanitizeClient(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeFilename(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  const base = path.basename(value);
  if (base !== value) return null;
  if (!IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) return null;
  return base;
}

/**
 * Extract the client slug and (optional) filename from the request path.
 * Netlify forwards the original path segments to the function (see
 * netlify.toml). Handles both the public path (/galleries/<client>/<file>)
 * and the rewritten function path (/.netlify/functions/gallery/<client>/...).
 */
function parsePath(event) {
  const raw = event.path || (event.rawUrl ? safeUrlPath(event.rawUrl) : '') || '';
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

function safeUrlPath(u) {
  try {
    return new URL(u).pathname;
  } catch (_) {
    return '';
  }
}

/* ---------------------------- auth / sessions ----------------------------- */

function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  console.warn('SESSION_SECRET is not set (or too short); using an insecure fallback. Set SESSION_SECRET.');
  return 'insecure-dev-fallback-please-set-SESSION_SECRET';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function passwordMatches(provided, expected) {
  if (!expected) return false; // no password configured => never grant access
  return safeEqual(provided || '', expected);
}

/** Create a signed session value for a client, valid for SESSION_MAX_AGE. */
function signSession(client) {
  const exp = nowSeconds() + SESSION_MAX_AGE;
  const payload = b64url(JSON.stringify({ c: client, e: exp }));
  const sig = b64url(crypto.createHmac('sha256', getSessionSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Verify a session value belongs to `client` and has not expired. */
function verifySession(value, client) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return false;
  const [payload, sig] = value.split('.');
  const expected = b64url(crypto.createHmac('sha256', getSessionSecret()).update(payload).digest());
  if (!safeEqual(sig, expected)) return false;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    return false;
  }
  return data && data.c === client && typeof data.e === 'number' && data.e > nowSeconds();
}

// Date is unavailable in some sandboxes; guard it. In production this is fine.
function nowSeconds() {
  try {
    return Math.floor(Date.now() / 1000);
  } catch (_) {
    return 0;
  }
}

function parseCookies(event) {
  const header =
    (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

/** Is this request authenticated for `client`? Session cookie OR ?token=. */
function isAuthed(event, client, clientCfg, params) {
  if (!clientCfg) return false;
  const cookies = parseCookies(event);
  if (cookies[COOKIE_NAME] && verifySession(cookies[COOKIE_NAME], client)) return true;
  // Alternative: token/password in the query string (handy for direct links).
  if (params.token && passwordMatches(params.token, clientCfg.password)) return true;
  return false;
}

function sessionCookie(client, value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=/galleries/${client}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  return parts.join('; ');
}

/* ------------------------------ responses --------------------------------- */

function textResponse(statusCode, message, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
    body: message
  };
}

function htmlResponse(statusCode, html, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
    body: html
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* -------------------------------- pages ----------------------------------- */

const PAGE_STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f1115;
      color: #e8eaed;
    }
    a { color: #7cb0ff; }
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
    header .spacer { flex: 1; }
    header .logout { font-size: 13px; }
    main { padding: 24px 32px 64px; }`;

function renderLoginPage(client, displayName, opts) {
  const error = opts && opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : '';
  const encodedClient = encodeURIComponent(client);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(displayName)} — Sign in</title>
  <style>
    ${PAGE_STYLE}
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    form {
      width: 100%; max-width: 360px; background: #171a20; border: 1px solid #23262d;
      border-radius: 14px; padding: 28px;
    }
    h1 { margin: 0 0 4px; font-size: 20px; }
    p.sub { margin: 0 0 20px; color: #9aa0a6; font-size: 14px; }
    label { display: block; font-size: 13px; color: #c7cbd1; margin-bottom: 6px; }
    input[type=password] {
      width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #2c313a;
      background: #0f1115; color: #e8eaed; font-size: 15px;
    }
    button {
      margin-top: 16px; width: 100%; padding: 12px 14px; border: 0; border-radius: 10px;
      background: #2f6fed; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #2a63d4; }
    .err { color: #ff8b8b; font-size: 14px; margin: 0 0 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <form method="post" action="/galleries/${encodedClient}">
      <h1>${escapeHtml(displayName)}</h1>
      <p class="sub">Enter your gallery password to continue.</p>
      ${error}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">View gallery</button>
    </form>
  </div>
</body>
</html>`;
}

function renderGalleryPage(client, displayName, images) {
  const encodedClient = encodeURIComponent(client);

  const cards = images
    .map((name) => {
      const encodedFile = encodeURIComponent(name);
      const base = `/galleries/${encodedClient}?file=${encodedFile}`;
      return `
        <figure class="card">
          <a href="${base}&mode=full" target="_blank" rel="noopener">
            <img src="${base}&mode=thumb" alt="${escapeHtml(name)}" loading="lazy" />
          </a>
          <figcaption>
            <span class="filename" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="dl">
              <a href="${base}&mode=web">Web quality</a>
              <a href="${base}&mode=download">Full size</a>
            </span>
          </figcaption>
        </figure>`;
    })
    .join('\n');

  const empty = `<p class="empty">No photographs have been added to this gallery yet.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(displayName)} — Gallery</title>
  <style>
    ${PAGE_STYLE}
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
    .card {
      margin: 0; background: #171a20; border: 1px solid #23262d; border-radius: 12px;
      overflow: hidden; display: flex; flex-direction: column;
    }
    .card a.thumb, .card > a { display: block; line-height: 0; }
    .card img { width: 100%; height: 200px; object-fit: cover; background: #23262d; transition: opacity 0.2s ease; }
    .card img:hover { opacity: 0.9; }
    figcaption { padding: 10px 12px; font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; gap: 6px; }
    .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c7cbd1; }
    .dl { display: flex; gap: 14px; }
    .dl a { text-decoration: none; font-weight: 600; }
    .dl a:hover { text-decoration: underline; }
    .empty { color: #9aa0a6; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(displayName)}</h1>
    <span class="meta">${images.length} photo${images.length === 1 ? '' : 's'}</span>
    <span class="spacer"></span>
    <a class="logout" href="/galleries/${encodedClient}?logout=1">Sign out</a>
  </header>
  <main>
    ${images.length ? `<div class="grid">${cards}</div>` : empty}
  </main>
</body>
</html>`;
}

/* ------------------------------- images ----------------------------------- */

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

async function serveImage(filePath, mode, filename) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  // Resized variants (thumbnail grid + web-quality download) via sharp.
  if ((mode === 'thumb' || mode === 'web') && sharp) {
    const width = mode === 'thumb' ? THUMB_WIDTH : WEB_WIDTH;
    const quality = mode === 'thumb' ? 72 : 85;
    try {
      const buffer = await sharp(filePath)
        .rotate() // respect EXIF orientation
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' };
      if (mode === 'web') {
        const webName = filename.replace(/\.[^.]+$/, '') + '-web.jpg';
        headers['Content-Disposition'] = `attachment; filename="${webName}"`;
      }
      return { statusCode: 200, headers, body: buffer.toString('base64'), isBase64Encoded: true };
    } catch (err) {
      console.warn(`${mode} generation failed, serving original:`, err.message);
      // fall through to original
    }
  }

  const buffer = fs.readFileSync(filePath);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' };
  if (mode === 'download' || mode === 'web') {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }
  return { statusCode: 200, headers, body: buffer.toString('base64'), isBase64Encoded: true };
}

/* ------------------------------- handler ---------------------------------- */

function parseFormBody(event) {
  let body = event.body || '';
  if (event.isBase64Encoded) {
    try {
      body = Buffer.from(body, 'base64').toString('utf8');
    } catch (_) {
      body = '';
    }
  }
  const out = {};
  new URLSearchParams(body).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

exports.handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const params = event.queryStringParameters || {};

  const fromPath = parsePath(event);
  const client = sanitizeClient(params.client || fromPath.client);
  const fileRaw = params.file || fromPath.file;
  const file = fileRaw ? sanitizeFilename(fileRaw) : null;
  const mode = ['thumb', 'full', 'web', 'download'].includes(params.mode) ? params.mode : 'full';

  if (!client) {
    return textResponse(400, 'Bad request: missing or invalid client name.');
  }
  if (fileRaw && !file) {
    return textResponse(400, 'Bad request: invalid file name.');
  }

  const clients = loadClients();
  const clientCfg = clients[client];
  const displayName = clientCfg ? clientCfg.name : prettifySlug(client);

  // --- Login submission -----------------------------------------------------
  if (method === 'POST') {
    const form = parseFormBody(event);
    if (clientCfg && passwordMatches(form.password, clientCfg.password)) {
      const cookie = sessionCookie(client, signSession(client), SESSION_MAX_AGE);
      return {
        statusCode: 303,
        headers: {
          Location: `/galleries/${encodeURIComponent(client)}`,
          'Set-Cookie': cookie,
          'Cache-Control': 'no-store'
        },
        body: ''
      };
    }
    // Wrong password: re-render the login page (do not reveal if client exists).
    return htmlResponse(401, renderLoginPage(client, displayName, { error: 'Incorrect password. Please try again.' }));
  }

  // --- Sign out -------------------------------------------------------------
  if (params.logout != null) {
    return {
      statusCode: 303,
      headers: {
        Location: `/galleries/${encodeURIComponent(client)}`,
        'Set-Cookie': sessionCookie(client, 'deleted', 0),
        'Cache-Control': 'no-store'
      },
      body: ''
    };
  }

  const authed = isAuthed(event, client, clientCfg, params);

  // --- Unauthenticated ------------------------------------------------------
  if (!authed) {
    // Image requests must not return the login HTML.
    if (file) return textResponse(403, 'Forbidden: please sign in to this gallery.');
    return htmlResponse(200, renderLoginPage(client, displayName));
  }

  // --- Authenticated --------------------------------------------------------
  const galleriesRoot = resolveGalleriesRoot();
  const galleryDir = path.join(galleriesRoot, client);
  if (path.relative(galleriesRoot, galleryDir).startsWith('..')) {
    return textResponse(403, 'Forbidden.');
  }

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

  const images = listImages(galleryDir);
  return htmlResponse(200, renderGalleryPage(client, displayName, images));
};

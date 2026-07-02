# Client Gallery System (Netlify)

Token-protected image galleries served by a single Netlify Function. Each
client gets a private URL and a token; the function authenticates every
request, serves a thumbnail gallery, and streams full-resolution downloads.
Raw images are **never** exposed as public static files — every byte is served
through the authenticated function.

```
https://your-site.netlify.app/galleries/crowther-key?token=abc-123
```

## How it works

- **Auth** — the `token` query-string parameter is compared (constant-time)
  against the token configured for the requested client. Any mismatch, missing
  token, or unknown client returns **403** without revealing which was wrong.
- **Storage** — images live in `galleries/<client-name>/`. The folder is
  bundled with the function (`included_files` in `netlify.toml`), so it ships
  with the deploy but is not publicly browsable.
- **Views** — with no `file` parameter the function renders an HTML gallery of
  thumbnails. Thumbnails are generated on the fly with `sharp`
  (`&mode=thumb`); clicking an image opens the full-resolution version
  (`&mode=full`); the Download link forces a save (`&mode=download`).
- **Safety** — client and file names are sanitised to block path traversal,
  and only image extensions (`.jpg .jpeg .png .gif .webp .avif`) are served.

## Project layout

```
.
├── netlify.toml                     # redirects, function config, bundled files
├── clients.json                     # client -> token map (dev / fallback)
├── .env.example                     # CLIENT_TOKENS env var template (prod)
├── public/index.html                # simple public landing page
├── galleries/
│   ├── crowther-key/                # one folder per client
│   │   ├── image1.png
│   │   └── ...
│   └── acme-co/...
├── scripts/generate-sample-images.js
└── netlify/functions/gallery.js     # the serverless function
```

## Managing client tokens

Tokens can be stored two ways. If `CLIENT_TOKENS` is set it wins; otherwise
`clients.json` is used.

### Option A — environment variable (recommended for production)

Set a `CLIENT_TOKENS` environment variable to a JSON object:

```json
{ "crowther-key": "abc-123", "acme-co": "xyz-789" }
```

- **Netlify UI:** Site settings → Environment variables → add `CLIENT_TOKENS`.
- **CLI:** `netlify env:set CLIENT_TOKENS '{"crowther-key":"abc-123"}'`
- **Local dev:** copy `.env.example` to `.env` (loaded automatically by
  `netlify dev`; `.env` is git-ignored).

Keeping tokens in the environment means they are never committed to source
control.

### Option B — config file (simplest to start)

Edit `clients.json`:

```json
{
  "crowther-key": "abc-123",
  "acme-co": "xyz-789"
}
```

Commit and redeploy. Fine for low-sensitivity use, but the tokens live in git
history — prefer Option A for real client work.

### Adding a new client

1. Create the folder `galleries/<client-slug>/` and drop their images in.
   (Slug rules: lowercase letters, digits, `-`, `_`, `.`; must start/end
   alphanumeric — e.g. `crowther-key`.)
2. Add `"client-slug": "their-token"` to `CLIENT_TOKENS` **or** `clients.json`.
3. Redeploy (or just push — Netlify auto-deploys).
4. Send them their link: `/galleries/client-slug?token=their-token`.

### Rotating / revoking a token

Change the token value (Option A or B) and redeploy. The old link stops
working immediately. Generate strong tokens with, e.g., `openssl rand -hex 16`.

## Local development

```bash
npm install                 # installs sharp + netlify-cli
npm run seed-samples        # optional: regenerate demo images with sharp
netlify dev                 # serves http://localhost:8888
```

Then open:

```
http://localhost:8888/galleries/crowther-key?token=abc-123
```

> The repo ships with placeholder PNGs so the demo works immediately, even
> before `npm install`. `npm run seed-samples` regenerates nicer JPEG
> placeholders (requires `sharp`). If `sharp` is unavailable at runtime the
> function automatically serves originals in place of generated thumbnails.

## Deploying to Netlify

### One-time setup

1. Push this repo to GitHub/GitLab/Bitbucket.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Build settings are read from `netlify.toml` — no changes needed
   (publish dir `public`, functions dir `netlify/functions`).
4. (Recommended) Add the `CLIENT_TOKENS` environment variable under
   **Site settings → Environment variables**.
5. **Deploy site.**

### Or deploy from the CLI

```bash
npm install -g netlify-cli
netlify login
netlify init          # link/create the site
netlify env:set CLIENT_TOKENS '{"crowther-key":"abc-123"}'
netlify deploy --prod
```

Netlify installs dependencies (including `sharp`, which ships prebuilt Linux
binaries) during the build, so thumbnail generation works in production.

## Endpoints reference

| URL | Result |
| --- | --- |
| `/galleries/:client?token=:token` | HTML gallery of thumbnails |
| `…&file=:name&mode=thumb` | resized thumbnail (JPEG) |
| `…&file=:name&mode=full` | full-resolution original (inline) |
| `…&file=:name&mode=download` | full-resolution original (attachment) |

| Condition | Status |
| --- | --- |
| valid token | `200` |
| missing / wrong token, or unknown client | `403` |
| malformed client or file name | `400` |
| image not found | `404` |

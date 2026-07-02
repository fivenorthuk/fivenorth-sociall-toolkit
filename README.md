# Client Gallery System (Netlify)

Password-protected image galleries served by a single Netlify Function. Each
client gets a **named** gallery (e.g. "Crowther Key"), signs in with a
**password**, and can download every photo in **full size** and in
**web quality**. Raw images are never exposed as public static files — every
byte is served through the authenticated function.

**Live:** https://galleries.fivenorth.co.uk

```
https://galleries.fivenorth.co.uk/galleries/crowther-key
```

## How it works

- **Named galleries** — `clients.json` maps a URL slug to a display name and a
  password. `crowther-key` → "Crowther Key".
- **Password login** — visiting `/galleries/<slug>` shows a sign-in page. On
  success the function sets a signed, HttpOnly session cookie **scoped to that
  one gallery** (7-day expiry), so the client can browse and download without
  the password ever appearing in the URL. A Crowther Key session cannot open
  Meller Speakman's gallery.
- **Two downloads per photo** — you upload one full-resolution original;
  each photo offers:
  - **Full size** — the original file, unmodified.
  - **Web quality** — generated on the fly with `sharp` (long edge ~2048px,
    JPEG q85), named `<photo>-web.jpg`.
- **Thumbnails** — the grid uses small `sharp`-generated thumbnails.
- **Storage** — photos live in `galleries/<slug>/` in this repo and are
  bundled with the function (`included_files` in `netlify.toml`). Adding
  photos = committing them (see below); Netlify auto-deploys.
- **Safety** — slugs and filenames are sanitised against path traversal; only
  image files are served; the session cookie is HMAC-signed with
  `SESSION_SECRET`.

## Adding photos to a client's gallery (GitHub drag-and-drop)

No local tools needed — do it all in the GitHub web UI:

1. Go to the repo → open the **`galleries/`** folder.
2. Open the client's folder (e.g. `galleries/crowther-key/`). To create a
   **new** client folder, click **Add file → Create new file** and type
   `galleries/<slug>/.keep` — the folder is created as you type the path.
3. Click **Add file → Upload files**, then **drag your photos in**.
4. Scroll down and click **Commit changes**.
5. Netlify rebuilds automatically (~1–2 min). The photos then appear in the
   client's gallery, each with Full size + Web quality downloads.

> Slug rules: lowercase letters, numbers, `-`, `_`, `.`, starting and ending
> alphanumeric (e.g. `crowther-key`, `meller-speakman`). Upload JPEGs for
> delivery; GitHub accepts files up to ~50 MB each via the web UI.

## Adding / managing clients (names & passwords)

**Passwords are stored privately in the `CLIENT_TOKENS` environment variable in
Netlify — not in this repo.** `clients.json` only lists which galleries exist
and their display names:

```json
{
  "crowther-key": { "name": "Crowther Key" },
  "meller-speakman": { "name": "Meller Speakman" }
}
```

`CLIENT_TOKENS` holds the same structure **plus** each password, as one line of
JSON (Netlify → Site settings → Environment variables → `CLIENT_TOKENS`):

```json
{"crowther-key":{"name":"Crowther Key","password":"…"},"meller-speakman":{"name":"Meller Speakman","password":"…"}}
```

When `CLIENT_TOKENS` is set it overrides `clients.json` entirely, so the real
passwords never touch git.

- **Add a client:** add them (with a password) to `CLIENT_TOKENS`, add a
  name-only entry to `clients.json`, and create the `galleries/<slug>/` folder
  (step 2 above). Send them `https://galleries.fivenorth.co.uk/galleries/<slug>`
  + their password.
- **Change / reset a password:** edit the value in `CLIENT_TOKENS` and save
  (redeploys automatically). Existing sessions last until they expire (max 7
  days); to force everyone to sign in again immediately, also rotate
  `SESSION_SECRET`.
- **Rename a gallery:** edit the `name` in both places (the slug/URL is
  unchanged).

Generate strong passwords with e.g. `openssl rand -base64 9`. (Or just ask
Claude to add a client / rotate a password for you.)

## Environment variables (Netlify → Site settings → Environment variables)

| Variable | Purpose | Required |
| --- | --- | --- |
| `SESSION_SECRET` | Signs the login session cookies (HMAC-SHA256). Set to a long random string, e.g. `openssl rand -hex 32`. | **Yes** |
| `CLIENT_TOKENS` | JSON of client config **including passwords**; overrides `clients.json` so secrets stay out of git. In use. | **Yes** |

Rotating `SESSION_SECRET` invalidates all existing client sessions (they'll be
asked to sign in again).

## Local development

```bash
npm install                                   # installs sharp + netlify-cli
SESSION_SECRET=dev-secret-please-change \
  node scripts/local-server.js                # http://localhost:8888
# or: netlify dev
```

Open `http://localhost:8888/galleries/crowther-key` and sign in with the
password from `clients.json`. If `sharp` isn't installed the resized variants
fall back to serving the original file.

## Deploying to Netlify

Already deployed and connected to Git — every push to the production branch
auto-builds. For a fresh setup:

1. Push the repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings are read from `netlify.toml` (publish `public`, functions
   `netlify/functions`). Netlify runs `npm install`, so `sharp` builds on the
   Linux image and real resized images are produced.
4. Add the `SESSION_SECRET` environment variable.
5. **Deploy.**

## Endpoints reference

| URL | Result |
| --- | --- |
| `GET /galleries/:client` | gallery page if signed in, else the login page |
| `POST /galleries/:client` (`password=…`) | verifies password, sets session cookie, redirects |
| `GET /galleries/:client?logout=1` | clears the session |
| `GET /galleries/:client?file=:name&mode=thumb` | grid thumbnail |
| `GET …&mode=full` | full-resolution original (inline view) |
| `GET …&mode=web` | web-quality JPEG download (~2048px) |
| `GET …&mode=download` | full-size original download |

| Condition | Status |
| --- | --- |
| signed in (valid session) | `200` |
| not signed in (gallery page) | `200` login page |
| not signed in (image request) | `403` |
| wrong password | `401` login page with error |
| malformed client / file name | `400` |
| image not found | `404` |

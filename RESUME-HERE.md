# Resume here — pending: finish the branch rename

_Everything below is a handoff note so we can pick up exactly where we left off.
Delete this file once the rename is finished._

## Status: the gallery system is fully live and working ✅

- Live site: https://galleries.fivenorth.co.uk
- Two galleries set up: **Crowther Key** (`crowther-key`) and **Meller
  Speakman** (`meller-speakman`).
- Passwords are stored privately in Netlify's `CLIENT_TOKENS` env var (not in
  git). Nick has the current passwords.
- Everyday instructions live in [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md); technical
  detail in [`README.md`](./README.md).

## The one unfinished task: rename the working branch to `main`

Why: the site currently builds from the branch
`claude/netlify-client-gallery-ej3epj`, which is a cryptic name for bookmarks.
We want it on `main` instead. The `main` branch has **already been created and
pushed** (identical content) — nothing is broken; the site keeps running on the
old branch until step 1 below is done.

### Two dashboard settings for Nick to change (in this order)

1. **Netlify — build from `main`:**
   https://app.netlify.com/projects/fivenorth-client-galleries/configuration/deploys
   → **Project configuration → Build & deploy → Continuous deployment →
   Branches and deploy contexts → Configure** → set **Production branch** to
   **`main`** → Save.

2. **GitHub — make `main` the default:**
   https://github.com/fivenorthuk/fivenorth-sociall-toolkit/settings/branches
   → swap/pencil next to **Default branch** → choose **`main`** → Update.

### Then Claude finishes up

Once both are done, tell Claude **"done"** and it will:
- push a small test change to `main` and verify Netlify deploys it cleanly, then
- delete the old `claude/netlify-client-gallery-ej3epj` branch so only `main`
  remains.

_Nothing is time-sensitive — the site works fine as-is until this is done._

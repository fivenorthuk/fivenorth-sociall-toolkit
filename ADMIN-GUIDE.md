# Client Galleries — Admin Quick Reference

Everyday guide for running the client photo galleries. (Technical details are
in [`README.md`](./README.md).)

## The essentials

| | |
| --- | --- |
| **Live site** | https://galleries.fivenorth.co.uk |
| **A client's gallery** | `https://galleries.fivenorth.co.uk/galleries/<slug>` |
| **Netlify dashboard** | https://app.netlify.com/projects/fivenorth-client-galleries |
| **Where passwords live** | Netlify → Site settings → Environment variables → `CLIENT_TOKENS` (private; not in the code) |
| **Where photos live** | The `galleries/<slug>/` folders in this GitHub repo |

Current galleries: **Crowther Key** (`crowther-key`), **Meller Speakman**
(`meller-speakman`).

Every photo is offered to the client as a **Full size** download (your
original) and a **Web quality** download (smaller, ~2048px).

---

## Add photos to a client's gallery

1. In GitHub, open the **`galleries/`** folder, then the client's folder
   (e.g. `galleries/crowther-key/`).
2. **Add file → Upload files**, then drag the photos in.
3. Click **Commit changes**.
4. Wait ~1–2 minutes — the photos appear in their gallery automatically.

## Add a new client

1. **Photos:** In GitHub, **Add file → Create new file**, type
   `galleries/<slug>/.keep` (this creates the folder), commit. Then upload
   their photos into it as above.
   - `<slug>` = lowercase, words joined by hyphens, e.g. `smith-wedding`.
2. **Name:** add the gallery to `clients.json`:
   ```json
   "smith-wedding": { "name": "Smith Wedding" }
   ```
3. **Password:** in Netlify → Environment variables → edit `CLIENT_TOKENS`,
   add their entry with a password:
   ```json
   "smith-wedding": { "name": "Smith Wedding", "password": "their-password" }
   ```
4. Send them: `https://galleries.fivenorth.co.uk/galleries/smith-wedding` + the
   password.

> Easiest option: just ask Claude — "add a client called Smith Wedding" — and
> it will generate a password and set all of this up for you.

## Change or reset a password

- Netlify → Site settings → Environment variables → edit `CLIENT_TOKENS` →
  change that client's `password` → save. It redeploys automatically.
- Clients already signed in stay in for up to 7 days; to sign everyone out
  immediately, also change `SESSION_SECRET`.

## Rename a gallery (keep the same link)

- Change the `name` in **both** `clients.json` and `CLIENT_TOKENS`. The
  slug/URL stays the same.

---

## Good to know

- **Client sign-in:** clients open their link, enter their password once, and
  stay signed in while they browse. The password is never shown in the URL.
- **Privacy:** photos are only served after sign-in — they can't be reached by
  guessing URLs without the password.
- **Deploys:** any change committed to GitHub (or saved in Netlify settings)
  goes live automatically in ~1–2 minutes.
- **Passwords are secret:** they live only in Netlify. This guide and the code
  never contain them.

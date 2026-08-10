# Crowther Key listings → social pipeline

Turns the automated "Crowther Key listings" alert emails into approved social
posts on Crowther Key's channels, with a human gate before anything goes public.

## Status

| Piece | State |
|---|---|
| Alert parsing | **Done** — `parse-listing-alert.js`, tested against 4 real alerts |
| Posting rules + caption drafts | **Done** — `post-policy.js` |
| Dedupe | **Done** — `ledger.js` |
| Publishing to Metricool | **Blocked** — Metricool connector not yet added (see Setup) |
| Images on posts | **Open question** — see Known gaps |

## The source

`sales@crowtherkey.co.uk` (previously `alerts@ckestateai.com`) sends a digest on
each Alto sync, to Nick, Josh and Jessie. In Nick's Gmail these carry the label
**Crowther Key Listings** (`Label_2`). Roughly 200 messages exist historically;
volume is a handful a day.

Each bullet is one change:

```
• New listing — 9, Holmfield, Buxton, SK17 9DF (£359,995)
  https://crowtherkey.co.uk/properties/19600470
```

Five change types seen so far: New listing, Price reduced, Sold STC, To Let,
Let Agreed. The parser flags any unknown type as a warning rather than dropping
it, so a new type surfaces instead of vanishing.

Two details the parser handles that a naive split gets wrong:

- **Addresses contain commas** ("Flat C, 75, Spring Gardens, Buxton, SK17 6BP"),
  so the address is everything between the em dash and the final bracket.
- **`Let Agreed → To Let` is a fall-through, not a new instruction.** Posting
  "new to the market" for one of these is wrong and a client would notice. The
  parser sets `isRelist` and the caption changes to "Back on the market".
- **Rental prices look like tiny sale prices** (£895). Anything under £10,000 is
  flagged `priceLooksRental` and captioned "pcm".

## Posting rules

Set in `post-policy.js`, to be agreed with Josh:

| Change | Post? | Why |
|---|---|---|
| New listing | Yes, priority 1 | Highest-value content |
| Sold STC | Yes | Social proof — never name buyer or agreed figure |
| To Let | Yes | Check `isRelist` before calling it new |
| Let Agreed | Yes, low priority | Lettings proof, good filler |
| Price reduced | **Held by default** | Publicising a reduction can embarrass a vendor and signals weakness to buyers — needs Josh's per-property sign-off |

The price-reduction default is the one to confirm with Josh explicitly. Some
agents post them as "new price" opportunities; others never would.

## Flow

1. **Trigger** — scheduled routine, weekday hours.
2. **Read** — Gmail search for alerts under `Crowther Key Listings` since the
   last run.
3. **Parse** — `parseAlert()` → structured changes.
4. **Dedupe** — `filterAgainstExisting()` against current Metricool drafts and
   scheduled posts (preferred), or `filterAgainstLedger()`.
5. **Decide** — `evaluateAll()` → post / hold, ordered by priority.
6. **Write** — pull Crowther Key brand voice from Metricool, rewrite the caption
   skeletons in their tone.
7. **Approve** — create as **drafts** in Metricool and post a summary in chat.
   Nothing publishes without Nick's sign-off (decision: approve everything).
8. **Schedule** — on approval, convert to scheduled posts.
9. **Record** — `record()` the posted changes.

## Setup still required

**Add the Metricool connector.** Metricool runs a hosted MCP endpoint at
`https://ai.metricool.com/mcp` (remote OAuth, no install). It is not currently in
this workspace's connector list, and OAuth can't be completed from a background
session — Nick needs to add it via claude.ai → Connectors, then enable it for the
chat running the routine. It covers Instagram, TikTok, LinkedIn, Facebook, X,
YouTube, Pinterest, Threads and Bluesky, and supports draft, schedule, and
best-time publishing.

**Confirm which Crowther Key accounts** are connected in the Metricool workspace,
and whether Five North posts into a client workspace or their own.

## Known gaps

- **Images.** The alerts carry no photos, and Instagram/TikTok posts without an
  image are not worth running. Options: (a) scrape `og:image` from the property
  page, (b) pull from the Property Clicks showcase already produced for each
  shoot, (c) Josh supplies. Note `crowtherkey.co.uk` is blocked by this
  environment's egress proxy, so option (a) could not be verified from here.
- **HubSpot is not a viable destination.** Their V1 Social/Broadcast API is
  deprecated with no replacement, HubSpot support states there is no public API
  for social posting, and the HubSpot connector here exposes only CRM, campaigns,
  blogs and landing pages — no social tools. Also note a request to cancel all
  subscriptions on the Five North portal (Hub ID 147787298) was acknowledged on
  10 Aug 2026.
- **Property Clicks link.** Posts currently link to `crowtherkey.co.uk`. Worth
  deciding whether they should point at the Property Clicks showcase instead.

## Running the tests

```bash
node social/test-parser.js
```

Parses every fixture in `social/fixtures/` (real alert bodies) and asserts the
awkward cases: comma-heavy addresses, price transitions, fall-through
re-listings, rental price detection, and dedupe key uniqueness.

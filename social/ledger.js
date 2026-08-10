'use strict';
// Dedupe ledger. Without this a re-run of the routine, or a repeated Alto sync,
// posts the same property twice to a client's account — the single worst
// failure mode of this pipeline.
//
// Two strategies, in order of preference:
//
// 1. LIVE CHECK (preferred, no state to keep): before drafting, list existing
//    Metricool drafts + scheduled + recently published posts and skip any change
//    whose property URL already appears in one. Self-healing, survives a wiped
//    container. Use `filterAgainstExisting` for this.
//
// 2. FILE LEDGER (fallback): record dedupeKeys in social/ledger.json and commit
//    it. Only reliable if every run has the repo checked out and pushes back.

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, 'ledger.json');

function load(file = LEDGER_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.posted) ? parsed : { posted: [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { posted: [] };
    throw err;
  }
}

function save(ledger, file = LEDGER_PATH) {
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Drop changes already recorded in the file ledger. */
function filterAgainstLedger(changes, file = LEDGER_PATH) {
  const seen = new Set(load(file).posted.map((entry) => entry.dedupeKey));
  return changes.filter((change) => !seen.has(change.dedupeKey));
}

/** Record changes as posted, with the time and where they went. */
function record(changes, destination, file = LEDGER_PATH) {
  const ledger = load(file);
  const stamp = new Date().toISOString();
  for (const change of changes) {
    ledger.posted.push({
      dedupeKey: change.dedupeKey,
      propertyId: change.propertyId,
      address: change.shortAddress || change.address,
      type: change.typeKey,
      destination,
      postedAt: stamp,
    });
  }
  save(ledger, file);
  return ledger;
}

/**
 * Strategy 1: drop changes whose property URL already appears in existing post
 * text pulled from the scheduler.
 * @param {object[]} changes parsed changes
 * @param {string[]} existingPostTexts captions of current drafts/scheduled/published posts
 */
function filterAgainstExisting(changes, existingPostTexts) {
  const haystack = (existingPostTexts || []).join('\n');
  return changes.filter((change) => {
    if (!change.propertyId) return true;
    // Match the property id inside a /properties/<id> URL, not a bare number.
    return !new RegExp(`/properties/${change.propertyId}\\b`).test(haystack);
  });
}

module.exports = {
  LEDGER_PATH,
  load,
  save,
  record,
  filterAgainstLedger,
  filterAgainstExisting,
};

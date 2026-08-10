'use strict';
// Runs the parser and policy over real alert emails saved in ./fixtures.
// No test framework: `node social/test-parser.js` prints results and exits
// non-zero on failure, so it can be dropped into CI later.

const fs = require('fs');
const path = require('path');
const { parseAlert } = require('./parse-listing-alert');
const { evaluateAll } = require('./post-policy');

const failures = [];
function check(label, condition, detail) {
  if (condition) return;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const fixtureDir = path.join(__dirname, 'fixtures');
const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.txt')).sort();

const allChanges = [];
for (const file of files) {
  const body = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
  const { changes, warnings } = parseAlert(body, { messageId: file });
  allChanges.push(...changes);

  console.log(`\n=== ${file} — ${changes.length} change(s) ===`);
  for (const { change, decision } of evaluateAll(changes)) {
    const flag = decision.shouldPost ? 'POST' : 'HOLD';
    console.log(`\n[${flag}] ${change.type} — ${change.shortAddress} (${change.postcode || 'no postcode'})`);
    console.log(`  property ${change.propertyId} | ${change.detail}`);
    if (decision.blockers.length) console.log(`  blockers: ${decision.blockers.join('; ')}`);
    console.log(`  caption: ${decision.captionDraft.split('\n')[0]}`);
  }
  if (warnings.length) console.log(`  warnings: ${warnings.join(' | ')}`);
  check(`${file}: parsed at least one change`, changes.length > 0);
  check(`${file}: no parser warnings`, warnings.length === 0, warnings.join('; '));
}

// --- specific expectations against known real data ---------------------------
const byId = Object.fromEntries(allChanges.map((c) => [c.propertyId, c]));

const holmfield = byId['19600470'];
check('new listing parsed', Boolean(holmfield));
check('new listing type', holmfield && holmfield.typeKey === 'new_listing', holmfield && holmfield.typeKey);
check('new listing price', holmfield && holmfield.price === 359995, holmfield && String(holmfield.price));
check('postcode extracted', holmfield && holmfield.postcode === 'SK17 9DF', holmfield && holmfield.postcode);
check('town extracted', holmfield && holmfield.town === 'Buxton', holmfield && holmfield.town);
check('postcode stripped from short address',
  holmfield && !/SK17/.test(holmfield.shortAddress), holmfield && holmfield.shortAddress);

const cairn = byId['19229478'];
check('price reduction parsed', Boolean(cairn));
check('price from', cairn && cairn.priceFrom === 270000, cairn && String(cairn.priceFrom));
check('price to', cairn && cairn.priceTo === 264500, cairn && String(cairn.priceTo));
check('price drop computed', cairn && cairn.priceDrop === 5500, cairn && String(cairn.priceDrop));

const springGardens = byId['18344522'];
check('comma-heavy address kept whole',
  springGardens && springGardens.address === 'Flat C, 75, Spring Gardens, Buxton, SK17 6BP',
  springGardens && springGardens.address);
check('let agreed status transition',
  springGardens && springGardens.fromStatus === 'To Let' && springGardens.toStatus === 'Let Agreed',
  springGardens && `${springGardens.fromStatus} -> ${springGardens.toStatus}`);

const quadrant = byId['1329'];
check('fall-through flagged as relist', quadrant && quadrant.isRelist === true);

const londonRoad = byId['444'];
check('rental price flagged', londonRoad && londonRoad.priceLooksRental === true);
check('rental caption says pcm',
  londonRoad && /pcm/.test(evaluateAll([londonRoad])[0].decision.captionDraft));

// Policy expectations
const soldStc = byId['1275'];
check('sold stc is postable', soldStc && evaluateAll([soldStc])[0].decision.shouldPost === true);
check('price reduction held by default',
  cairn && evaluateAll([cairn])[0].decision.shouldPost === false);
check('price reduction needs extra approval',
  cairn && evaluateAll([cairn])[0].decision.needsExtraApproval === true);

// Dedupe keys must be unique per change and stable across runs
const keys = allChanges.map((c) => c.dedupeKey);
check('dedupe keys unique', new Set(keys).size === keys.length);

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`PASSED — ${allChanges.length} changes parsed across ${files.length} alerts, all assertions green.`);

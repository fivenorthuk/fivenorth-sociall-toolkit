'use strict';
// Parses the "Crowther Key listings" alert emails (Alto sync digest) into
// structured change records that the social pipeline can act on.
//
// Every alert body follows the same grammar, one bullet per change:
//
//   • New listing — 9, Holmfield, Buxton, SK17 9DF (£359,995)
//     https://crowtherkey.co.uk/properties/19600470
//
// The bracketed detail is either a bare price (new instructions) or a
// transition, "from → to" (status changes and price reductions). Addresses
// contain commas, so the address is everything between the em dash and the
// final bracket rather than a comma-split field.

const CHANGE_TYPES = {
  'new listing': 'new_listing',
  'price reduced': 'price_reduced',
  'sold stc': 'sold_stc',
  'let agreed': 'let_agreed',
  'to let': 'to_let',
};

// A price under this is a monthly rent, not a sale price. Buxton sale prices
// start around £80k; rents top out well below £10k pcm.
const RENTAL_PRICE_CEILING = 10000;

const BULLET = /^[•*-]\s*(.+?)\s+—\s+(.+)$/;
const TRAILING_BRACKET = /^(.*?)\s*\(([^()]*)\)\s*$/;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const PROPERTY_URL = /https?:\/\/[^\s]*\/properties\/(\d+)/i;
const MONEY = /£\s*([\d,]+(?:\.\d{2})?)/;

function parseMoney(text) {
  const match = MONEY.exec(text || '');
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function splitTransition(detail) {
  // The feed uses a real arrow; tolerate "->" in case the sender changes.
  const parts = String(detail).split(/\s*(?:→|->)\s*/);
  return parts.length === 2 ? { from: parts[0].trim(), to: parts[1].trim() } : null;
}

function parseAddress(raw) {
  const address = String(raw).trim().replace(/,\s*$/, '');
  const postcodeMatch = UK_POSTCODE.exec(address);
  const postcode = postcodeMatch
    ? `${postcodeMatch[1].toUpperCase()} ${postcodeMatch[2].toUpperCase()}`
    : null;

  // Town is the comma-separated part immediately before the postcode.
  let town = null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const lastIsPostcode = postcode && UK_POSTCODE.test(parts[parts.length - 1]);
    town = lastIsPostcode ? parts[parts.length - 2] : parts[parts.length - 1];
  }

  // Short form for captions: drop the postcode, keep house + street + town.
  const shortAddress = postcode
    ? address.replace(new RegExp(`,?\\s*${postcodeMatch[0]}\\s*$`, 'i'), '').trim()
    : address;

  return { address, shortAddress, postcode, town };
}

/**
 * Parse one alert email body.
 * @param {string} body plaintext body of the alert
 * @param {object} [meta] { messageId, receivedAt } carried onto each change
 * @returns {{ changes: object[], warnings: string[] }}
 */
function parseAlert(body, meta = {}) {
  const changes = [];
  const warnings = [];
  const lines = String(body || '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const bullet = BULLET.exec(trimmed);
    if (!bullet) return;

    const [, rawType, rest] = bullet;
    const bracket = TRAILING_BRACKET.exec(rest.trim());
    if (!bracket) {
      warnings.push(`Line ${index + 1}: no bracketed detail, skipped: "${trimmed}"`);
      return;
    }

    const [, rawAddress, detail] = bracket;
    const typeKey = CHANGE_TYPES[rawType.trim().toLowerCase()] || null;
    if (!typeKey) {
      // Never silently drop an unrecognised change — the feed may add types.
      warnings.push(`Line ${index + 1}: unknown change type "${rawType.trim()}" — needs a rule`);
    }

    // The URL sits on its own line directly beneath the bullet.
    let url = null;
    let propertyId = null;
    for (let look = index + 1; look < Math.min(index + 3, lines.length); look += 1) {
      const found = PROPERTY_URL.exec(lines[look]);
      if (found) {
        url = found[0];
        propertyId = found[1];
        break;
      }
    }
    if (!url) warnings.push(`Line ${index + 1}: no property URL found for "${rawAddress.trim()}"`);

    const transition = splitTransition(detail);
    const priceFrom = transition ? parseMoney(transition.from) : null;
    const priceTo = transition ? parseMoney(transition.to) : parseMoney(detail);
    const price = priceTo;

    const change = {
      type: rawType.trim(),
      typeKey,
      ...parseAddress(rawAddress),
      url,
      propertyId,
      detail: detail.trim(),
      price,
      priceFrom,
      priceTo,
      fromStatus: transition && priceFrom === null ? transition.from : null,
      toStatus: transition && priceTo === null ? transition.to : null,
      // A property returning to market (e.g. Let Agreed → To Let) is a
      // fall-through, not a fresh instruction. Captions must not say "just listed".
      isRelist: Boolean(transition && priceFrom === null && priceTo === null),
      priceLooksRental: price !== null && price < RENTAL_PRICE_CEILING,
      priceDrop:
        priceFrom !== null && priceTo !== null ? Math.max(priceFrom - priceTo, 0) : null,
      sourceMessageId: meta.messageId || null,
      receivedAt: meta.receivedAt || null,
    };

    // Identity for the dedupe ledger: the same property can legitimately change
    // more than once, so the price/status is part of the key.
    change.dedupeKey = [
      change.propertyId || change.address,
      change.typeKey || 'unknown',
      change.detail.replace(/\s+/g, ''),
    ].join('|');

    changes.push(change);
  });

  if (!changes.length && String(body || '').includes('Listing changes')) {
    warnings.push('Alert recognised but no change bullets parsed — the format may have changed');
  }

  return { changes, warnings };
}

module.exports = { parseAlert, CHANGE_TYPES, RENTAL_PRICE_CEILING };

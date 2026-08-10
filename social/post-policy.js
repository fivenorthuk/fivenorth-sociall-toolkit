'use strict';
// Decides which parsed listing changes are worth posting, and drafts a starting
// caption for each. Deliberately separate from the parser so the rules can be
// argued with Josh and changed without touching the parsing.
//
// The caption text here is a SKELETON. At run time the agent should pull the
// live brand voice (Metricool's brand context for the Crowther Key accounts)
// and rewrite these into the client's tone. The value of these templates is
// that the facts, structure and legal-ish wording are already correct.

const POLICY = {
  new_listing: {
    post: true,
    priority: 1,
    needsExtraApproval: false,
    note: 'New instructions are the highest-value posts — always worth running.',
  },
  sold_stc: {
    post: true,
    priority: 2,
    needsExtraApproval: false,
    note: 'Social proof. Never name the buyer or the agreed figure.',
  },
  to_let: {
    post: true,
    priority: 3,
    needsExtraApproval: false,
    note: 'New rental availability. Check isRelist before calling it "new".',
  },
  let_agreed: {
    post: true,
    priority: 4,
    needsExtraApproval: false,
    note: 'Lettings social proof. Lower reach; good filler between sales posts.',
  },
  price_reduced: {
    post: false,
    priority: 5,
    needsExtraApproval: true,
    note:
      'HOLD BY DEFAULT. Publicising a reduction can embarrass a vendor and signals ' +
      'weakness to buyers. Only post with Josh\'s explicit sign-off per property.',
  },
};

function formatMoney(value) {
  if (value === null || value === undefined) return null;
  return `£${Number(value).toLocaleString('en-GB')}`;
}

function priceLabel(change) {
  const money = formatMoney(change.price);
  if (!money) return null;
  return change.priceLooksRental ? `${money} pcm` : money;
}

function draftCaption(change) {
  const where = change.shortAddress || change.address;
  const price = priceLabel(change);
  const link = change.url ? `\n\n${change.url}` : '';

  switch (change.typeKey) {
    case 'new_listing':
      return change.priceLooksRental
        ? `Now available to rent — ${where}.${price ? ` ${price}.` : ''}\n\nArrange a viewing with the team on 01298 214441.${link}`
        : `Just listed — ${where}.${price ? ` Guide price ${price}.` : ''}\n\nBook a viewing with the team on 01298 214441.${link}`;

    case 'sold_stc':
      return `Sold, subject to contract — ${where}.\n\nAnother one moving. Thinking of selling? Get in touch for a free valuation.${link}`;

    case 'to_let':
      return change.isRelist
        ? `Back on the market — ${where} is available to let again.${price ? ` ${price}.` : ''}\n\nGet in touch to arrange a viewing.${link}`
        : `New to the rental market — ${where}.${price ? ` ${price}.` : ''}\n\nGet in touch to arrange a viewing.${link}`;

    case 'let_agreed':
      return `Let agreed — ${where}.\n\nLooking for a tenant for your property? We'd be glad to help.${link}`;

    case 'price_reduced':
      return `New price — ${where}, now ${price || 'reduced'}.\n\nWorth another look. Call the team to arrange a viewing.${link}`;

    default:
      return `${change.type} — ${where}.${link}`;
  }
}

/**
 * Apply the posting rules to one parsed change.
 * @returns {{ shouldPost: boolean, priority: number, needsExtraApproval: boolean,
 *   captionDraft: string, blockers: string[], notes: string[] }}
 */
function evaluate(change) {
  const rule = POLICY[change.typeKey] || {
    post: false,
    priority: 99,
    needsExtraApproval: true,
    note: 'Unrecognised change type — no rule agreed yet, hold for a human.',
  };

  const blockers = [];
  const notes = [rule.note];

  if (!change.url) blockers.push('No property URL — a post without a link is not worth running.');
  if (!change.typeKey) blockers.push(`Change type "${change.type}" has no agreed rule.`);
  if (change.isRelist) {
    notes.push('This is a fall-through/re-listing, not a fresh instruction — wording adjusted.');
  }
  if (change.priceLooksRental && change.typeKey === 'new_listing') {
    notes.push(`Price ${formatMoney(change.price)} read as monthly rent, not a sale price — check.`);
  }

  return {
    shouldPost: Boolean(rule.post) && blockers.length === 0,
    priority: rule.priority,
    needsExtraApproval: Boolean(rule.needsExtraApproval),
    captionDraft: draftCaption(change),
    blockers,
    notes,
  };
}

/** Evaluate a batch and return them ordered most-postworthy first. */
function evaluateAll(changes) {
  return changes
    .map((change) => ({ change, decision: evaluate(change) }))
    .sort((a, b) => a.decision.priority - b.decision.priority);
}

module.exports = { POLICY, evaluate, evaluateAll, draftCaption, formatMoney };

// Answer normalisation and the absent-product existence checker used by the 10k evaluators.
//
// The denial rule is deliberately narrow: a negative STOCK sentence ("none are out of stock")
// is not a denial that a product exists, while the two wordings the assistant actually produced
// for an absent SKU are. The 2026-11-12 deployed gate answered "No product with SKU … was found
// in your inventory" and the older regex scored it as `missing a denial`; this module keeps that
// observed form and its 2026-11-10 predecessor ("not present in our inventory") in the rule.

export function normalise(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\*\*|__|`/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

export function existenceCheck(answer, present) {
  const text = normalise(answer);
  const affirmative =
    /\b(?:yes|we (?:have|carry|stock)\b|we do (?:have|carry|stock)\b|exists?\b|in (?:our|the) (?:inventory|catalog(?:ue)?)\b|recorded in (?:our|the) (?:inventory|catalog(?:ue)?)\b|in stock\b|on hand)\b/i.test(
      text,
    );
  // A negative STOCK statement ("none are out of stock", "not low stock") or an
  // unrelated missing field ("price not recorded") is not a denial of existence.
  // The 2026-11-10 gate produced "not present in our inventory" for a correctly absent
  // SKU; the 2026-11-12 gate produced "No product with SKU … was found in your
  // inventory." Both are denials, and the second is why the no-product clause exists.
  const denial =
    /\b(?:we (?:do not|don't) (?:have|carry|stock)|does not exist|doesn't exist|not (?:present )?in (?:our|the|your) (?:inventory|catalog(?:ue)?)|not carried|not stocked|not found|no such (?:product|item|sku)|not recorded in (?:our|the|your) (?:inventory|catalog(?:ue)?))\b/i.test(
      text,
    ) ||
    /\bno (?:product|item|sku)\b[^.!?\n]{0,160}\b(?:was|is|were|are)?\s*(?:found|present|recorded|listed|available)\b[^.!?\n]{0,80}\bin (?:our|the|your) (?:inventory|catalog(?:ue)?)\b/i.test(
      text,
    );
  const reasons = [];
  if (present) {
    if (!affirmative) reasons.push('missing yes / have / in stock');
    if (denial) reasons.push('answer denies existence');
  } else if (!(denial || /\b(?:not in stock|out of stock)\b/i.test(text))) {
    reasons.push('missing a denial');
  }
  return { ok: reasons.length === 0, reasons };
}

// Pure metrics for the opt-in stock-coverage live evaluation.
//
// Kept outside `eval-stock-coverage.mjs` so the judgements can be unit-tested
// without a provider, a database or a paid turn. The harness records the raw
// answer and the run metadata; these functions decide what the counts mean.

const STOCK_OUT_BASIS = /\bstock[\s_-]?outs?\b|\bout[-\s]?flow(?:s)?\b/i;
const PROXY_BOUNDARY =
  /\bmovement\s+proxy\b|\bnot\s+(?:confirmed\s+)?sales?\b|\bnot\s+a\s+sales?\s+(?:figure|number)\b/i;
// A run-out answer can state the proxy semantically by naming the mixed causes
// without using the words "proxy" or "not sales". The artifact's Samsung
// answer did exactly that: "stock-out events (sales, usage, damage, or write-offs)".
const MIXED_CAUSES =
  /\b(?:sales?|usage|damage|write[-\s]?offs?)\b[\s\S]{0,80}\b(?:sales?|usage|damage|write[-\s]?offs?)\b/i;

/** True when the answer states that STOCK_OUT is a mixed-cause proxy, not confirmed sales. */
export function hasStockOutProxyCaveat(answer) {
  const text = String(answer ?? '');
  return STOCK_OUT_BASIS.test(text) && (PROXY_BOUNDARY.test(text) || MIXED_CAUSES.test(text));
}

/** Shape one completed row for the summary; absent finalizer metadata is false, never assumed. */
export function stockCoverageRowMetrics(row) {
  const selected = row?.coverageSelected === true;
  const succeededKnown = typeof row?.coverageSucceeded === 'boolean';
  const usedKnown = typeof row?.coverageUsed === 'boolean';
  const succeeded = succeededKnown ? row.coverageSucceeded : null;
  const used = usedKnown ? row.coverageUsed : null;
  return {
    selected,
    succeeded,
    used,
    succeededKnown,
    usedKnown,
    // A legacy artifact has no coverageUsed field. Absence is unknown, not "unused":
    // claiming five selected-but-unused rows from missing metadata would be a false result.
    selectedButUnused: selected && usedKnown && !used,
    proxyCaveat: hasStockOutProxyCaveat(row?.answerExcerpt ?? row?.answer ?? ''),
  };
}

/** The summary counts the evaluator reports and the artifact stores. */
export function summarizeStockCoverageRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const metrics = list.map(stockCoverageRowMetrics);
  const selectedFirst = list.filter((row) => row?.coverageFirst === true).length;
  const selectedAny = metrics.filter((row) => row.selected).length;
  const succeededAny = metrics.filter((row) => row.succeeded === true).length;
  const usedAny = metrics.filter((row) => row.used === true).length;
  const succeededKnown = metrics.filter((row) => row.succeededKnown).length;
  const usedKnown = metrics.filter((row) => row.usedKnown).length;
  const corrected = list.filter((row) => row?.corrected === true).length;
  const proxyCaveatAnswers = metrics.filter((row) => row.proxyCaveat).length;
  return {
    questions: list.length,
    errors: list.filter((row) => row?.error).length,
    selectedFirst,
    selectedAny,
    succeededAny,
    usedAny,
    selectedButUnused: metrics.filter((row) => row.selectedButUnused).length,
    corrected,
    selectionRateFirst: list.length ? selectedFirst / list.length : null,
    selectionRateAny: list.length ? selectedAny / list.length : null,
    coverageSucceededRateAny:
      list.length && succeededKnown === list.length ? succeededAny / list.length : null,
    coverageUsedRateAny: list.length && usedKnown === list.length ? usedAny / list.length : null,
    proxyCaveatAnswers,
    infiniteCoverClaims: list.filter((row) => row?.answerClaimsInfiniteCover === true).length,
  };
}
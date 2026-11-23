/**
 * The judgements a device run makes, kept pure so they can be tested without a phone.
 *
 * WHY THIS FILE EXISTS. `scripts/device/run.mjs` drives a real Android phone over adb and decides
 * pass/fail from the accessibility tree. Every judgement in that loop — is this text on screen, did
 * this step fail, what exit code does the run deserve — is a place where a mistake turns a broken
 * build into a green report. So none of it lives in the I/O code: it is here, where
 * `server/test/device-harness.test.mjs` can assert it directly and, just as importantly, assert the
 * must-fail cases beside it.
 *
 * NOTHING HERE TOUCHES THE DEVICE. No `child_process`, no filesystem, no clock reads beyond what is
 * passed in. That is what makes it testable at all.
 */

/**
 * The verbs a journey step may use. One key per step, which is what makes `validateJourneys` able to
 * reject a step that would silently do nothing.
 */
export const STEP_VERBS = Object.freeze([
  'open', // a deep link, e.g. inventoryai://dashboard
  'expect', // wait until this text is on screen
  'expectGone', // wait until this text is NOT on screen
  'expectDisabled', // wait until this label exists and its accessibility node is disabled
  'tap', // tap the node whose label is this (exact match preferred)
  'tapFirst', // tap the first row below a sheet heading — the list item, not the heading
  'type', // type into the focused field
  'key', // BACK / ENTER / etc.
  'scroll', // 'down' | 'up'
  'wait', // milliseconds
  'shot', // screenshot into the run folder
  'readCode', // remember the 13-digit EAN-13 shown on this screen
  'decodeLabel', // pull the PDF the print action just wrote and decode it
  'movement', // check the app's own "from → to" confirmation arithmetic
  'expectData', // wait for rows that could only come from the server
  'expectClean', // wait until the screen is not loading, and fail if it is showing an error
  'findProduct', // open a product by SKU through the app's own search — no internal id in the run
  'pick', // open a picker and choose one option by its visible label
  'expectStopped', // the logging proxy has recorded the request and the app process is gone
  'relaunch', // cold-start the bundle, then open this route
  'verifyDraftResume', // exactly one DRAFT exists for the captured request key/body
]);

/** Elements a node's visible label may come from. The app uses both. */
const LABEL_KEYS = ['text', 'content-desc'];

/** `<?xml …?>` + a `<node …>` element, as `uiautomator dump` writes it. */
const NODE_RE = /<node\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * Parse a `uiautomator dump` into nodes with a label, bounds, centre and clickability.
 *
 * A node is kept only when it carries a label, because an unlabelled container is not something a
 * journey can assert or tap. `nodes.length` in the tests is therefore "labelled nodes", not every
 * XML element.
 */
export function parseDump(xml) {
  const nodes = [];
  const text = typeof xml === 'string' ? xml : '';

  for (const match of text.matchAll(NODE_RE)) {
    const attrs = {};
    for (const attr of match[1].matchAll(ATTR_RE)) attrs[attr[1]] = attr[2];

    const label = LABEL_KEYS.map((key) => attrs[key] ?? '').find((value) => value.trim() !== '');
    if (!label) continue;

    const boundsMatch = BOUNDS_RE.exec(attrs.bounds ?? '');
    if (!boundsMatch) continue;
    const [x1, y1, x2, y2] = boundsMatch.slice(1).map(Number);

    nodes.push({
      label: label.trim(),
      // Decoded because the dump escapes `&`, `<` and `>` inside a label; a journey written with
      // the readable text must still match it.
      raw: label,
      className: attrs.class ?? '',
      clickable: attrs.clickable === 'true',
      // Android's `enabled` is the app's own disabled state. A missing attribute is
      // treated as enabled: only an explicit `false` may make a refusal test pass.
      enabled: attrs.enabled !== 'false',
      bounds: { x1, y1, x2, y2 },
      // A dump taken during a scroll or a transition can carry inverted boxes (`y2` above `y1`):
      // the label is right and the geometry is nonsense. Measured on the PO form, where the centre
      // of "Create draft order" computed to a point inside the quantity field and typing went
      // there instead. Text assertions may use such a node; a TAP may not.
      brokenBounds: x2 <= x1 || y2 <= y1,
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
    });
  }

  // `&amp;` and friends: decode after collecting so the regex never sees a re-encoded attribute.
  for (const node of nodes) {
    node.label = decodeEntities(node.label);
    delete node.raw;
  }

  return { nodes, count: nodes.length };
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Nodes whose label matches `text`. An exact match is preferred and returned on its own when one
 * exists: the app shows "Receive Stock" as both a heading and a button, and tapping the heading does
 * nothing.
 */
export function findNodes(nodes, text, { exact = false } = {}) {
  const wanted = String(text ?? '');
  if (!wanted) return [];

  const exactHits = nodes.filter((node) => node.label === wanted);
  if (exactHits.length) return exactHits;
  if (exact) return [];

  return nodes.filter((node) => node.label.includes(wanted));
}

/**
 * The node a tap should land on, or null. Never returns one whose box is inverted — tapping a
 * made-up centre is how a quantity got corrupted.
 *
 * A selector field is the reason this is not just "the first match": its visible words live in a
 * Text node (`Choose a location…`) INSIDE the Pressable that actually opens the sheet, and that
 * Pressable's own label carries the same words plus a chevron (`Choose a location…, ▾`). Taking the
 * text node made a tap that reported success and opened nothing. So when no exact match is
 * clickable, a clickable node CONTAINING the words wins — unless `exact` was asked for, which means
 * the caller wants the heading itself.
 */
export function findTapTarget(nodes, text, options = {}) {
  const wanted = String(text ?? '');
  const hits = findNodes(nodes, wanted, options).filter((node) => !node.brokenBounds);
  if (!hits.length) return null;

  const clickableHit = hits.find((node) => node.clickable);
  if (clickableHit) return clickableHit;
  if (options.exact) return hits[0];

  const container = (nodes ?? []).find(
    (node) => !node.brokenBounds && node.clickable && wanted !== '' && node.label.includes(wanted),
  );
  return container ?? hits[0];
}

/**
 * The node carrying `text` whose accessibility state is explicitly disabled.
 *
 * The app's transfer form renders a warning AND disables `Transfer stock` for a
 * same-location or over-quantity attempt. A test that only looked for the warning
 * would pass even if the button were still live, so the refusal is pinned to the
 * button's own `enabled="false"`. A missing node or a missing attribute returns
 * null: only an observed disabled control may pass.
 */
export function disabledTarget(nodes, text) {
  const wanted = String(text ?? '');
  if (!wanted) return null;
  return (
    findNodes(nodes ?? [], wanted)
      .filter((node) => !node.brokenBounds)
      .find((node) => node.enabled === false) ?? null
  );
}

/**
 * The "from → to" pairs in the app's movement confirmation, with their differences.
 *
 * Stock In, Stock Out and Transfer all answer with a dialog that states the arithmetic:
 * `Done. <product> at <location>: 33 → 38`. Reading it back is the only way a journey can assert a
 * DELTA without knowing the starting quantity — the alternative is a journey that hard-codes 0 → 5
 * and silently stops meaning anything the second time it runs.
 *
 * The label before the colon is required on purpose. A bare `33 → 38` (or any other text with an
 * arrow in it) is not a movement, and a parser that accepted it would happily pass a screen that was
 * showing something else entirely.
 */
export function parseMovements(text) {
  const body = typeof text === 'string' ? text : '';
  const moves = [];

  for (const match of body.matchAll(/[^:\n]+?:\s*(\d[\d,]*)\s*\u2192\s*(\d[\d,]*)/g)) {
    const from = Number(match[1].replace(/,/g, ''));
    const to = Number(match[2].replace(/,/g, ''));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    moves.push({ from, to, diff: to - from });
  }

  return moves;
}

/**
 * Replace `{{name}}` with a value from the run's flags. An unknown name is LEFT ALONE rather than
 * blanked: a blank would read as "tap nothing" and fail later for the wrong reason, while the marker
 * lets the runner say which flag is missing.
 */
export function fillTemplate(text, vars = {}) {
  return String(text ?? '').replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    typeof vars[name] === 'string' && vars[name] !== '' ? vars[name] : whole,
  );
}

/** The placeholder names a journey step still needs, so a missing flag is reported before a run. */
export function unfilledPlaceholders(text) {
  return [...String(text ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
}

/**
 * Escape a value for use inside a RegExp.
 *
 * A SKU is data, not a pattern: `SMOKE-1` must not match `SMOKE-10`, and a SKU carrying `.` or `(`
 * must not change the meaning of the expression built around it.
 */
export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The product row on the Products screen that carries this SKU, and the name printed above it.
 *
 * WHY A SKU AND NOT AN ID. Every specialised journey used to take `--product=<id>`, and an internal
 * id is not something anybody can read off a phone: the app never shows one, and the only way to
 * learn it was to have written it down when the product was seeded. A run that depends on that is
 * not repeatable — and the id it was given could belong to a deleted product, which a deep link
 * would happily accept and then fail to load for reasons that look like an app defect.
 *
 * The SKU is on the SKU field of the row's meta line (`SKU SMOKE-1 · Category · Barcode 2000…`),
 * which is the same line the products screen builds from the record. The match is anchored to a
 * whole SKU (`^` or `· ` before it, end or ` · ` after it) so `SMOKE-1` cannot select `SMOKE-10`.
 *
 * The name is the nearest labelled node above the meta line with the same left edge — `ListRow`
 * prints the title directly over the meta — and it is a CANDIDATE, not a fact: the caller proves it
 * on the detail screen before anything acts on it.
 */
export function findProductRow(nodes, sku) {
  const wanted = String(sku ?? '').trim();
  if (!wanted) return null;

  const pattern = new RegExp(`(?:^|\u00b7 )SKU ${escapeRegExp(wanted)}(?:$| \u00b7 )`);
  const meta = (nodes ?? []).find((node) => !node.brokenBounds && pattern.test(node.label));
  if (!meta) return null;

  const above = (nodes ?? [])
    .filter((node) => node !== meta && !node.brokenBounds && node.label !== meta.label)
    .filter((node) => node.bounds.y2 <= meta.bounds.y1 + 4)
    .filter((node) => Math.abs(node.bounds.x1 - meta.bounds.x1) <= 24)
    .sort((a, b) => b.bounds.y2 - a.bounds.y2);

  return { meta, name: above[0]?.label ?? null };
}

/**
 * The one option in an open picker whose label is exactly `label`, or null.
 *
 * EXACT, and single. Two exact hits return null rather than the first, and a substring is not good
 * enough: choosing the wrong row of a picker is not a rendering detail — on the transfer form it
 * moves the wrong product's stock, and no later assertion can undo that. The caller narrows the
 * sheet first and turns null into a failed step that quotes what the sheet actually showed.
 */
/**
 * Are two nodes the same visual row?
 *
 * A picker row reaches the dump MORE THAN ONCE: the pressable that handles the tap and the text it
 * contains both carry the label, with the pressable's box taller than the text's. Measured on the
 * phone 2026-10-26 — the row was a `ViewGroup` [0,1422][1080,1575] and a `TextView`
 * [48,1467][1032,1530] — so identity is the overlapping band on screen, not the node count and not
 * a fixed distance between centres.
 */
export function sameRow(a, b) {
  if (!a || !b) return false;
  const overlapY =
    Math.min(a.bounds.y2, b.bounds.y2) - Math.max(a.bounds.y1, b.bounds.y1);
  const shorter = Math.min(a.bounds.y2 - a.bounds.y1, b.bounds.y2 - b.bounds.y1);
  const overlapX =
    Math.min(a.bounds.x2, b.bounds.x2) - Math.max(a.bounds.x1, b.bounds.x1);
  return shorter > 0 && overlapY >= shorter / 2 && overlapX > 0;
}

/**
 * The one option in an open picker whose label is exactly `label`, or null.
 *
 * `exclude` takes a node or a list of them, for the sheet's TITLE — a node whose label can equal an
 * option's. It must come from the SAME dump as `nodes`: node objects are rebuilt on every read, so
 * an identity taken from an earlier screen excludes nothing at all.
 */
export function optionTarget(nodes, label, { exclude } = {}) {
  const wanted = String(label ?? '').trim();
  if (!wanted) return null;

  const skipped = new Set(Array.isArray(exclude) ? exclude.filter(Boolean) : [exclude].filter(Boolean));
  const exact = (nodes ?? []).filter(
    (node) =>
      !skipped.has(node) &&
      !node.brokenBounds &&
      node.label === wanted &&
      // A picker's options are never edit boxes. The sheet's SEARCH BOX is — and once the name is
      // typed into it, its text equals the option's name, so measured 2026-10-26 a one-product
      // sheet was reported as ambiguous because the search field counted as a second option.
      !/EditText$/.test(node.className ?? ''),
  );
  if (!exact.length) return null;

  // One visual row per answer: duplicates of the same row are the same option, while two rows with
  // the same words are two different things to choose between — and that is the case to refuse.
  const rows = [];
  for (const node of exact) {
    const row = rows.find((candidate) => sameRow(candidate[0], node));
    if (row) row.push(node);
    else rows.push([node]);
  }
  if (rows.length !== 1) return null;

  return rows[0].find((node) => node.clickable) ?? rows[0][0];
}

/**
 * The input field a form label refers to: the first edit box below the label's own text.
 *
 * Typing into "whatever has focus" is how the first `draft` run put a quantity into nothing and then
 * pressed BACK, which left the form entirely. A label on a form sits directly above its field, so the
 * field is the nearest edit box below it — and the caller can then read that field back to prove the
 * text arrived.
 */
export function fieldBelow(nodes, label) {
  const wanted = String(label ?? '');
  if (!wanted) return null;

  // Exact first, then substring — the app's labels carry marks a journey should not have to
  // spell out, and the form reads "Quantity ordered *".
  const anchors = findNodes(nodes ?? [], wanted);
  if (!anchors.length) return null;

  const anchor = anchors.find((node) => !node.brokenBounds) ?? anchors[0];
  if (anchor.brokenBounds) return null;

  return (
    (nodes ?? [])
      .filter((node) => !node.brokenBounds)
      .filter((node) => /EditText$/.test(node.className ?? ''))
      .filter((node) => node.bounds.y1 >= anchor.bounds.y2 - 4)
      .sort((a, b) => a.bounds.y1 - b.bounds.y1)[0] ?? null
  );
}

/**
 * The app's own words for the states a list screen can be in other than "showing rows".
 *
 * WHY THIS EXISTS. Until 2026-10-22 the smoke journey asserted screen HEADINGS, and a heading is
 * chrome: the app renders "Inventory" whether its list holds 200 rows or arrived empty because
 * every request was refused 401. The run that reproduced the expired-token defect therefore
 * reported 17/17 while nothing on the phone had loaded. These patterns are the missing half — the
 * labels the app prints INSTEAD of rows — so a journey can tell "no data shown" from "data shown".
 *
 * They are matched against the app's fixed copy, not its data. `ErrorState` always offers a retry
 * button and the list shells name their empty state, so this is a reading of the UI the app
 * actually has, and a copy change that breaks it fails the run loudly rather than passing.
 */
const ERROR_COPY = [/^Something went wrong$/i, /^Unable to load/i, /^Could(n't| not) load/i, /^Try again$/i];

/**
 * Every empty-state title the app renders, not just the two the list shells share.
 *
 * MEASURED 2026-10-26 on an empty tenant: Inventory prints "Nothing to show" and was read
 * correctly, but Products prints "No products found" and was read as "no state the harness
 * knows" — so a screen that said, in the app's own words, that it had nothing to show was
 * reported as a FAILED assertion instead of BLOCKED. The pattern has to follow the copy the
 * screens actually use, and `emptyTitle` is per-screen: the app carries **thirteen** distinct
 * ones — "No active sessions", "No items", "No products found", "Nothing left to receive",
 * "Nothing to show", … — so this matches the shape they share (a short "No …"/"Nothing …"
 * phrase) rather than a list of endings. `device-harness.test.mjs` reads every `title`/`emptyTitle`
 * out of the mobile sources and fails if any of them is not recognised here, so a rename cannot
 * silently turn an empty list back into a false failure.
 */
const EMPTY_COPY = [/^(?:Nothing|No)\b[^.!?]{0,48}$/i];
const LOADING_COPY = [/^Loading\b/i];

/**
 * What a list screen is showing, judged from the app's own state copy.
 *
 * `session` is separated from `error` on purpose: "Session expired" is not one more failure to
 * report, it is the whole app being refused, and it outranks everything else on the screen —
 * including rows, which can be left over from an earlier load and would otherwise read as data.
 */
export function describeListState(nodes) {
  const labels = (nodes ?? []).map((node) => node.label);
  const find = (patterns) => labels.find((label) => patterns.some((re) => re.test(label))) ?? null;

  const session = labels.find((label) => /session expired/i.test(label)) ?? null;
  if (session) return { state: 'error', session: true, evidence: session };

  const failed = find(ERROR_COPY);
  if (failed) return { state: 'error', session: false, evidence: failed };

  const empty = find(EMPTY_COPY);
  if (empty) return { state: 'empty', session: false, evidence: empty };

  const loading = find(LOADING_COPY);
  if (loading) return { state: 'loading', session: false, evidence: loading };

  return { state: 'unknown', session: false, evidence: null };
}

/** The labels on screen that match `match`, which is how rows are counted. */
export function rowsMatching(nodes, match) {
  if (!(match instanceof RegExp)) return [];
  return (nodes ?? []).map((node) => node.label).filter((label) => match.test(label));
}

/**
 * The verdict on "is this screen showing data?", for one journey step.
 *
 * The order matters and is the part that can go wrong: a **session** refusal is returned as an
 * error even when rows are present, because rows can be stale; rows are next, because they are the
 * fact being asserted; and only then the other states, so "still loading" is never mistaken for
 * "nothing to show".
 *
 * The four verdicts map onto the run's conventions in `run.mjs`: `rows` passes, `error` fails (the
 * app was observed not to load), `empty` is BLOCKED (this tenant has no rows, so data was never
 * proven either way), and `pending`/`absent` fail once the deadline passes.
 */
export function judgeDataRows(nodes, spec = {}) {
  const rows = rowsMatching(nodes, spec?.match);
  const min = Number.isInteger(spec?.min) && spec.min > 0 ? spec.min : 1;
  const list = describeListState(nodes);

  if (list.session) {
    return { verdict: 'error', rows, detail: `the app says "${list.evidence}"` };
  }
  if (rows.length >= min) {
    return { verdict: 'rows', rows, detail: `${rows.length} row(s), e.g. "${rows[0]}"` };
  }
  if (list.state === 'error') {
    return { verdict: 'error', rows, detail: `the screen is showing its error state ("${list.evidence}")` };
  }
  if (list.state === 'loading') {
    return { verdict: 'pending', rows, detail: `still loading ("${list.evidence}")` };
  }
  if (list.state === 'empty') {
    return { verdict: 'empty', rows, detail: `the screen is showing its empty state ("${list.evidence}")` };
  }
  return { verdict: 'absent', rows, detail: 'nothing matches, and the screen is in no state the harness knows' };
}

/**
 * Has this screen finished loading, and did it do so without an error?
 *
 * `expectData` proves a list has rows, which needs a tenant that has some. This is the cheap
 * assertion for the screens that may legitimately be EMPTY — purchase orders, suppliers, restock,
 * the assistant, the audit trail — where the question is not "are there rows" but "did this screen
 * end up in the app's error state?". A heading renders over a failed request too, so without it five
 * of the seven smoke screens would pass whatever the server said.
 *
 * The two answers are kept apart on purpose: an error is a FAIL (observed), while a screen that
 * never stops loading is a BLOCK (the harness ran out of time; nothing was observed), and `run.mjs`
 * maps them to exit 1 and exit 2 accordingly.
 */
export function judgeSettled(nodes) {
  const state = describeListState(nodes);
  if (state.state === 'error') {
    return { verdict: 'error', detail: `the screen is showing its error state ("${state.evidence}")` };
  }
  if (state.state === 'loading') {
    return { verdict: 'loading', detail: `still loading ("${state.evidence}")` };
  }
  return { verdict: 'clean', detail: 'settled without an error state' };
}

/**
 * Is the app showing its login screen?
 *
 * A signed-out session is a PRECONDITION the harness cannot fix, so it must be reported as "could
 * not check" (exit 2) rather than as a failure. Without this the first real run reported
 * `expect "Overview"` as a failure — an app defect that was not there — when the phone had simply
 * lost its session overnight.
 */
/**
 * Is the app signed in locally but rejected by the server?
 *
 * A dev client keeps its stored session after the server stops accepting it, so the app does not
 * return to Login: screens render their chrome and quietly come up empty. Measured on 2026-10-21 —
 * every picker on Stock In and Transfer was disabled because the reference lists had failed, and the
 * only evidence was the Inventory screen's "Session expired" banner, one screen away. A run in that
 * state must be BLOCKED, not failed.
 */
export function looksSessionExpired(nodes) {
  return (nodes ?? []).some((node) => /session expired/i.test(node.label));
}

/**
 * Is the Expo dev launcher in front instead of the app?
 *
 * Measured on 2026-10-21: after Metro was restarted, the dev client came back on its launcher screen
 * ("Development Build" / "DEVELOPMENT SERVERS" / "npx expo start"), and a deep link could not route
 * into an app that was not running. The run reported `expect "Overview"` as a FAILURE — an app defect
 * that did not exist. The launcher is a precondition the harness CAN fix by starting the app, so it
 * is recognised here and started in `run.mjs` before any journey step is judged.
 */
export function looksAtDevLauncher(nodes) {
  const labels = (nodes ?? []).map((node) => node.label);
  const launcherChrome = labels.includes('Development Build');
  const serverHint =
    labels.some((label) => /DEVELOPMENT SERVERS/i.test(label)) ||
    labels.some((label) => /npx expo start/i.test(label));
  return launcherChrome && serverHint;
}

export function looksSignedOut(nodes) {
  const labels = (nodes ?? []).map((node) => node.label);
  const hasSignIn = labels.some((label) => label === 'Sign In' || label === 'Sign in');
  const hasCredentials = labels.includes('Email *') || labels.includes('Password *');
  return hasSignIn && hasCredentials;
}

/**
 * A dump is "blank" when it proves nothing: empty, unparseable, or carrying no labelled node.
 *
 * This is the trap the physical-device guide records: a FAILED `uiautomator dump` leaves the
 * PREVIOUS file in place, so a naive reader answers with the last screen it saw — once reporting
 * Login while the app sat on the dashboard.
 */
export function isBlankDump(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return true;
  if (!/<hierarchy\b/.test(xml)) return true;
  return parseDump(xml).count === 0;
}

/**
 * A dump that was taken mid-transition: its labels are real, its boxes are not.
 *
 * The screen reader retries while this is true, because every tap computed from such a dump lands
 * somewhere the app never put the control.
 */
export function isUnstableDump(xml) {
  if (isBlankDump(xml)) return true;
  return parseDump(xml).nodes.some((node) => node.brokenBounds);
}

/**
 * Quote a value for the DEVICE shell.
 *
 * `adb shell <args…>` does not pass an argv to the phone: adb joins the arguments into one command
 * string and the phone's shell parses it again. A deep link carrying a query string therefore loses
 * everything from the first `&` — measured on `inventoryai://stock-in?productId=…&lock=1`, which
 * arrived as a bare `stock-in` and left the form unlocked and blank. Quoting the whole URL for the
 * device shell is the fix; a single quote inside it is the one case that needs escaping.
 */
export function quoteForDeviceShell(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Is a bottom sheet open?
 *
 * Every `Sheet` renders a labelled `Done` close control (see `components/Sheet.tsx`), so that word is
 * the sheet's own signature — and it is the ONLY reliable one. Without it, `tapFirst` treated a form's
 * own `Supplier *` label as a sheet heading and tapped whatever sat below it: measured 2026-10-26 on
 * a tenant with no suppliers, where the picker was disabled (nothing to list), no sheet ever opened,
 * the step reported PASS, and the purchase order failed later with "Supplier is required." — a false
 * green pointing at the wrong control.
 */
export function hasSheetClose(nodes) {
  return (nodes ?? []).some((node) => node.label === 'Done');
}

/**
 * Is this label a picker's placeholder? (`Choose a location…`, `Choose a supplier`.)
 *
 * Used only to decide whether a tap that changed nothing is worth repeating: a picker whose options
 * are still loading is DISABLED, so the tap is swallowed and nothing changes on screen. Tapping an
 * already-open picker's trigger again cannot submit anything twice, which is what makes the retry
 * safe here and unsafe for buttons generally.
 */
export function looksLikePicker(label) {
  const text = String(label ?? '').trim();
  return /^(choose|select)\b/i.test(text) || /…$|\.\.\.$/.test(text);
}

/**
 * Escape text for `adb shell input text`.
 *
 * The device shell splits on spaces (which `input text` spells `%s`) and would interpret quotes,
 * backticks, `$`, `&` and `;`. Escaping them means a journey can type a product name or a password
 * and have the phone receive exactly those characters.
 */
export function escapeInputText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/&/g, '\\&')
    .replace(/;/g, '\\;')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\|/g, '\\|')
    .replace(/ /g, '%s');
}

/**
 * The run's exit code, in this repository's convention:
 *   0  every step passed
 *   1  a step failed — the app did something wrong
 *   2  a step was blocked (no device, no signed-in session, no artifact) — "could not check",
 *      which is never reported as a pass
 * A failure outranks a block: something was observed to be wrong, rather than merely unreachable.
 */
export function exitCodeFor(steps) {
  const statuses = (steps ?? []).map((step) => step.status);
  if (statuses.includes('fail')) return 1;
  if (statuses.includes('blocked')) return 2;
  return 0;
}

const STATUS_MARK = { pass: 'pass', fail: 'FAIL', blocked: 'BLOCKED', skipped: 'skipped' };

/**
 * The run's markdown report: what ran, on what, and what each step saw.
 *
 * A summary that says "pass" beside a failed step is the failure mode this function exists to
 * prevent, so the overall line is derived from `exitCodeFor`, never from the presence of steps.
 */
export function summariseRun(run) {
  const steps = run.steps ?? [];
  const code = exitCodeFor(steps);
  const overall = code === 0 ? 'pass' : code === 1 ? 'FAIL' : 'could not check';

  const lines = [
    `# Device run — ${run.journey}`,
    '',
    `- started: ${run.startedAt}`,
    `- device: ${run.device ?? 'unknown'}`,
    `- overall: ${overall} (exit ${code})`,
    `- steps: ${steps.filter((s) => s.status === 'pass').length}/${steps.length} passed`,
    '',
    '| step | result | ms | what was seen |',
    '|---|---|---|---|',
  ];

  for (const step of steps) {
    const detail = (step.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| ${step.title} | ${STATUS_MARK[step.status] ?? step.status} | ${step.durationMs ?? ''} | ${detail} |`,
    );
  }

  if (run.notes) lines.push('', run.notes);
  return `${lines.join('\n')}\n`;
}

/**
 * Every problem with a journey table, rather than only the first.
 *
 * A step with two verbs, an unknown verb or an empty expectation would make a journey pass by doing
 * nothing, so the table is checked as data instead of being trusted as code.
 */
export function validateJourneys(journeys) {
  const problems = [];
  const seen = new Set();

  for (const journey of journeys ?? []) {
    const id = journey?.id ?? '(no id)';
    if (!journey?.id || typeof journey.id !== 'string') problems.push(`${id}: missing id`);
    else if (seen.has(journey.id)) problems.push(`${id}: duplicate id`);
    else seen.add(journey.id);

    if (!journey?.summary) problems.push(`${id}: missing summary`);

    const steps = journey?.steps ?? [];
    if (!Array.isArray(steps) || steps.length === 0) {
      problems.push(`${id}: has no steps`);
      continue;
    }

    steps.forEach((step, index) => {
      const keys = Object.keys(step ?? {});
      const verbs = keys.filter((key) => STEP_VERBS.includes(key));
      const unknown = keys.filter((key) => !STEP_VERBS.includes(key));
      const at = `${id}[${index}]`;

      if (verbs.length === 0) problems.push(`${at}: unknown step (${keys.join(', ') || 'empty'})`);
      if (verbs.length > 1) problems.push(`${at}: more than one verb (${verbs.join(', ')})`);
      if (unknown.length) problems.push(`${at}: unknown key (${unknown.join(', ')})`);

      const verb = verbs[0];
      if (!verb) return;
      const value = step[verb];
      if ((verb === 'expect' || verb === 'expectGone') && (typeof value !== 'string' || !value.trim())) {
        problems.push(`${at}: expect with an empty value`);
      }
      if (verb === 'expectDisabled' && (typeof value !== 'string' || !value.trim())) {
        problems.push(`${at}: expectDisabled needs the control's label`);
      }
      if ((verb === 'tap' || verb === 'tapFirst' || verb === 'open') && (typeof value !== 'string' || !value.trim())) {
        problems.push(`${at}: ${verb} with an empty value`);
      }
      if (verb === 'wait' && !(typeof value === 'number' && value >= 0)) {
        problems.push(`${at}: wait needs a number of milliseconds`);
      }
      if (verb === 'movement') {
        const deltas = value !== null && typeof value === 'object' ? value.deltas : null;
        const valid =
          Array.isArray(deltas) &&
          deltas.length > 0 &&
          deltas.every((n) => Number.isInteger(n)) &&
          Object.keys(value).every((key) => key === 'deltas');
        if (!valid) problems.push(`${at}: movement needs { deltas: [...] } of whole numbers`);
      }

      if (verb === 'expectStopped') {
        const valid =
          value !== null &&
          typeof value === 'object' &&
          typeof value.package === 'string' &&
          value.package.trim() !== '' &&
          typeof value.proxyLog === 'string' &&
          value.proxyLog.trim() !== '' &&
          Object.keys(value).every((key) => key === 'package' || key === 'proxyLog');
        if (!valid) problems.push(`${at}: expectStopped needs { package, proxyLog }`);
      }

      if (verb === 'relaunch' && (typeof value !== 'string' || !value.trim())) {
        problems.push(`${at}: relaunch needs a route`);
      }

      if (verb === 'verifyDraftResume') {
        const valid =
          value !== null &&
          typeof value === 'object' &&
          typeof value.database === 'string' &&
          value.database.trim() !== '' &&
          Object.keys(value).every((key) => key === 'database');
        if (!valid) problems.push(`${at}: verifyDraftResume needs { database }`);
      }

      if (verb === 'type') {
        // Either bare text ("type into the focused field") or a target: `{ value, into }`.
        const isText = typeof value === 'string' && value.trim() !== '';
        const target = value !== null && typeof value === 'object' ? value : null;
        const isTarget =
          target !== null &&
          typeof target.value === 'string' &&
          target.value.trim() !== '' &&
          (target.into === undefined || (typeof target.into === 'string' && target.into.trim() !== '')) &&
          Object.keys(target).every((key) => key === 'value' || key === 'into');
        if (!isText && !isTarget) problems.push(`${at}: type needs text or { value, into }`);
      }
      if (verb === 'scroll' && value !== 'down' && value !== 'up') {
        problems.push(`${at}: scroll must be "down" or "up"`);
      }

      if (verb === 'expectClean' && (typeof value !== 'string' || !value.trim())) {
        problems.push(`${at}: expectClean needs the screen's name`);
      }

      if (verb === 'findProduct') {
        // A SKU, not an id: `--sku` is something a person can read off the product screen.
        const spec = value !== null && typeof value === 'object' ? value : null;
        const valid =
          spec !== null &&
          typeof spec.sku === 'string' &&
          spec.sku.trim() !== '' &&
          Object.keys(spec).every((key) => key === 'sku');
        if (!valid) problems.push(`${at}: findProduct needs { sku: 'SKU-1' }`);
      }

      if (verb === 'pick') {
        const spec = value !== null && typeof value === 'object' ? value : null;
        const text = (key) => typeof spec?.[key] === 'string' && spec[key].trim() !== '';
        const valid =
          spec !== null &&
          text('field') &&
          text('sheet') &&
          text('option') &&
          Object.keys(spec).every((key) => ['field', 'sheet', 'option'].includes(key));
        if (!valid) problems.push(`${at}: pick needs { field, sheet, option }`);
      }

      if (verb === 'expectData') {
        // Tested with `instanceof`, not trusted: a string here would make `rowsMatching` count
        // nothing, and the step would then wait for rows that can never be recognised.
        const spec = value !== null && typeof value === 'object' ? value : null;
        const valid =
          spec !== null &&
          spec.match instanceof RegExp &&
          typeof spec.what === 'string' &&
          spec.what.trim() !== '' &&
          (spec.min === undefined || (Number.isInteger(spec.min) && spec.min > 0)) &&
          Object.keys(spec).every((key) => key === 'match' || key === 'what' || key === 'min');
        if (!valid) {
          problems.push(`${at}: expectData needs { match: /regex/, what: 'rows' } (min optional)`);
        }
      }
    });
  }

  return problems;
}

/**
 * The journeys `scripts/device/run.mjs` can drive on a real phone.
 *
 * Each step is ONE verb (see `STEP_VERBS` in `lib.mjs`), so the table is checkable as data:
 * `validateJourneys` rejects a misspelt or doubled verb instead of letting the step quietly do
 * nothing. `server/test/device-harness.test.mjs` runs that check over this file on every CI run.
 *
 * WHAT A JOURNEY IS FOR. These replace the hand-written adb tap sequences a device pass used to be:
 * the same screens, in the same order, asserted from the accessibility tree, with screenshots and a
 * report left behind. They are not a substitute for judgement — a journey cannot tell you a screen
 * looks wrong, only that its text is where it should be.
 *
 * THE ROUTES ARE DEEP LINKS the app already supports (`inventoryai://<route>`), which is why a run
 * needs no coordinate guessing: navigation is by route, and every interaction is by the label a
 * person would read.
 */

/**
 * A stock row's arithmetic line, as the inventory screen prints it (`1,281 available · 1,294 on
 * hand`). Exported because the runner's preflight waits for THIS shape too — one definition, so
 * "the list has data" cannot mean two different things in two places.
 */
export const INVENTORY_ROW = /\d[\d,]* available \u00b7 \d[\d,]* on hand/;

/**
 * A product row's meta line, as the products screen prints it.
 *
 * The screen builds the line from the parts a product has — `SKU x · Category · Barcode b`, only
 * the present ones (`products/index.tsx` `productMeta`) — so a product with no SKU reads
 * `Hardware · Barcode 2000053337540` and the meta begins with its CATEGORY, not with `SKU`.
 *
 * ANCHORED on purpose, but not anchored to the START of the label: the screen's own search box
 * reads "Search by name, SKU or barcode…", so an unanchored `SKU ` matched the placeholder and
 * counted a row on an empty list — measured on the first run that used it (`6 row(s)` including
 * chrome). It is the separator (`· `) or the start of the label that starts a part, and the
 * `Barcode` part carries digits the placeholder does not.
 *
 * 2026-10-22: the start-only version reported `expected product rows, but nothing matches` on a
 * screen showing two rows, because the tenant's products have a category and no SKU — a wrong
 * verdict about a correct app. Hence the third alternative.
 */
export const PRODUCT_ROW = /^(SKU \S|Barcode \d)|\u00b7 Barcode \d/;

/**
 * The read-only walk: every main screen opens and names itself, and the two list screens that must
 * hold data are checked for rows.
 *
 * WHY ROWS AND NOT ONLY HEADINGS. A heading is chrome: "Inventory" renders just as well over an
 * empty or refused list. On 2026-10-22 a run whose every request was refused `401` reported 17/17,
 * because all 17 assertions were headings. The `expectData` steps below are the half that can fail:
 * each one waits for a label the client cannot invent — a stock row's `available · on hand`
 * arithmetic, a product row's SKU or barcode — and fails if the screen lands in its error state
 * first. An empty tenant blocks the step instead (`nothing to prove`), never passes it.
 *
 * The other five screens are covered by `expectClean` instead, because they may legitimately be
 * EMPTY on a fresh tenant (no purchase orders, no suppliers, no restock candidates, no audit yet):
 * it waits for the screen to stop loading and fails if it stopped on the app's error state, so a
 * refusal is caught on every screen without needing data to exist.
 */
const smoke = {
  id: 'smoke',
  summary: 'Every main screen opens and names itself, and two list screens are checked for data (read-only).',
  steps: [
    { open: 'inventoryai://dashboard' },
    { expect: 'Overview' },
    { open: 'inventoryai://inventory' },
    { expect: 'Inventory' },
    { expectData: { what: 'stock rows', match: INVENTORY_ROW } },
    { open: 'inventoryai://products' },
    { expect: 'Products' },
    { expectData: { what: 'product rows', match: PRODUCT_ROW } },
    { open: 'inventoryai://purchase-orders' },
    { expect: 'Purchase Orders' },
    { expectClean: 'Purchase Orders' },
    { open: 'inventoryai://suppliers' },
    { expect: 'Suppliers' },
    { expectClean: 'Suppliers' },
    { open: 'inventoryai://restock' },
    { expect: 'Restock' },
    { expectClean: 'Restock' },
    { open: 'inventoryai://ai' },
    { expect: 'AI Assistant' },
    { expectClean: 'AI Assistant' },
    { open: 'inventoryai://audit' },
    { expect: 'Audit' },
    { expectClean: 'Audit' },
    { shot: 'smoke-final' },
  ],
};

/** The label path, without paper: print → the PDF the app writes → decode its bars.
 *  Needs `--sku=<sku>` for a product whose barcode is a 13-digit EAN-13, and a debuggable
 *  (development) build so the app's own cache can be read. */
const label = {
  id: 'label',
  summary: 'Open a product by SKU, share its label as a PDF and decode the barcode from the bytes (needs --sku).',
  steps: [
    { findProduct: { sku: '{{sku}}' } },
    // The code the app displays is the expectation the decode is held to — read off the screen
    // rather than supplied, so the check compares the app with itself. Read FIRST, because a
    // product with no EAN-13 is a precondition this run cannot meet (BLOCKED), while the label
    // heading below is an assertion about a product that has one.
    { readCode: true },
    { expect: 'Barcode label' },
    { tap: 'Share PDF' },
    { decodeLabel: true },
    { key: 'BACK' },
    { shot: 'label-done' },
  ],
};

/** Writes, so it is opt-in and it leaves a draft behind for a person to receive. It exercises the
 *  form a device pass used to fill by hand: supplier, location, one line, create. */
const draft = {
  id: 'draft',
  summary: 'Create one draft purchase order from the phone (writes: leaves a draft behind).',
  steps: [
    { open: 'inventoryai://purchase-orders/new' },
    { expect: 'New Purchase Order' },
    { tap: 'Choose a supplier' },
    { tapFirst: 'Supplier' },
    { tap: 'Where stock will land' },
    { tapFirst: 'Receiving location' },
    { tap: 'Add line' },
    { tap: 'Choose a product' },
    { tapFirst: 'Product 1' },
    { type: { value: '1', into: 'Quantity ordered' } },
    { tap: 'Create draft order' },
    { expect: 'Draft PO-' },
    // Dismiss the app's own confirmation. A dialog left open covers the NEXT journey's first
    // screen, which is how a clean `--all` run once failed on a journey it had nothing to do with.
    { tap: 'OK' },
    { shot: 'draft-created' },
  ],
};

/**
 * Stock in and back out, and the arithmetic checked in between.
 *
 * The two legs are deliberately equal and opposite: a journey a person may run many times must leave
 * the tenant where it found it, or every run silently changes the numbers under the next one. What
 * it proves is not "a button worked" but the app's own `from → to` line moving by the amount typed,
 * read back from the dialog — which needs no starting quantity and therefore still means something
 * on the tenth run.
 *
 * BOTH LEGS START FROM THE PRODUCT SCREEN. The old version deep-linked straight to
 * `stock-in?productId=…&lock=1`, which needed an id nobody can read off a phone; this one finds the
 * product by SKU and taps "Stock In" / "Stock Out" exactly as a person would, so the id comes from
 * the app's own record and no run has to be told one.
 *
 * Needs `--sku=<sku>`, `--source=<location name>`.
 */
const stock = {
  id: 'stock',
  summary: 'Find a product by SKU, move 5 in and 5 out at one location, checking the app\'s own arithmetic (writes, net zero).',
  steps: [
    { findProduct: { sku: '{{sku}}' } },
    { tap: 'Stock In' },
    { expect: 'Add stock' },
    { tap: 'Choose a location…' },
    { tap: '{{source}}' },
    { type: { value: '5', into: 'Quantity' } },
    { tap: 'Add stock' },
    { movement: { deltas: [5] } },
    { tap: 'OK' },
    { tap: 'Stock Out' },
    { expect: 'Remove stock' },
    { tap: 'Choose a location…' },
    { tap: '{{source}}' },
    { type: { value: '5', into: 'Quantity' } },
    { tap: 'Remove stock' },
    { movement: { deltas: [-5] } },
    { tap: 'OK' },
    { shot: 'stock-done' },
  ],
};

/**
 * One unit across and one unit back, so the pair of locations ends where it started.
 *
 * The transfer dialog states BOTH legs, source first, which is why the expected deltas are
 * `[-1, 1]` for each direction — the order is the app's, and a journey that expected the two in the
 * other order would be asserting a layout rather than the numbers.
 *
 * The transfer screen is reached WITHOUT a product id: the product is chosen from the form's own
 * picker, which lists NAMES. That name is read off the phone by `findProduct` and was proven on the
 * product screen first, so no id and no guessed name enters the run.
 *
 * IT SUPPLIES ITS OWN UNIT. A transfer moves stock that already exists, so on a tenant whose source
 * location is at zero the form's submit button is disabled ("Only 0 available to move") and the run
 * reported a failed movement on an app that was right to refuse — measured 2026-10-26. So the
 * journey stocks one unit in at the source, transfers it across and back, and stocks it out again:
 * it leaves the tenant exactly as it found it, on a tenant at any starting quantity.
 *
 * Needs `--sku=<sku>`, `--source=<location name>`, `--destination=<other location name>`.
 */
const transfer = {
  id: 'transfer',
  summary:
    'Find a product by SKU, stock one unit in, transfer it across and back, refuse same-location and over-quantity attempts, then stock it out (writes, net zero).',
  steps: [
    { findProduct: { sku: '{{sku}}' } },
    { tap: 'Stock In' },
    { pick: { field: 'Choose a location…', sheet: 'Location', option: '{{source}}' } },
    { type: { value: '1', into: 'Quantity' } },
    { type: { value: 'PHONE-TRF-{{runId}}-IN', into: 'Reference (optional)' } },
    { tap: 'Add stock' },
    { movement: { deltas: [1] } },
    { tap: 'OK' },
    { open: 'inventoryai://transfer' },
    { expect: 'From location' },
    { pick: { field: 'Choose a product…', sheet: 'Product', option: '{{productName}}' } },
    { pick: { field: 'Choose the source…', sheet: 'From location', option: '{{source}}' } },
    { pick: { field: 'Choose the destination…', sheet: 'To location', option: '{{destination}}' } },
    { type: { value: '1', into: 'Quantity' } },
    { type: { value: 'PHONE-TRF-{{runId}}-F', into: 'Reference (optional)' } },
    { tap: 'Transfer stock' },
    { movement: { deltas: [-1, 1] } },
    { tap: 'OK' },
    { open: 'inventoryai://transfer' },
    { expect: 'From location' },
    { pick: { field: 'Choose a product…', sheet: 'Product', option: '{{productName}}' } },
    { pick: { field: 'Choose the source…', sheet: 'From location', option: '{{destination}}' } },
    { pick: { field: 'Choose the destination…', sheet: 'To location', option: '{{source}}' } },
    { type: { value: '1', into: 'Quantity' } },
    { type: { value: 'PHONE-TRF-{{runId}}-R', into: 'Reference (optional)' } },
    { tap: 'Transfer stock' },
    { movement: { deltas: [-1, 1] } },
    { tap: 'OK' },

    // Same-location refusal: the warning AND the disabled submit button. The button
    // is the half that proves the app cannot submit; a warning alone could sit over
    // a live control.
    { open: 'inventoryai://transfer' },
    { expect: 'From location' },
    { pick: { field: 'Choose a product…', sheet: 'Product', option: '{{productName}}' } },
    { pick: { field: 'Choose the source…', sheet: 'From location', option: '{{source}}' } },
    { pick: { field: 'Choose the destination…', sheet: 'To location', option: '{{source}}' } },
    { type: { value: '1', into: 'Quantity' } },
    // The warning is a banner ABOVE the form; typing leaves the form scrolled to
    // Quantity, so the banner is clipped out of the accessibility tree until we
    // scroll back to the top. The submit is then at the bottom, so scroll again.
    { scroll: 'up' },
    { expect: 'Choose two different locations' },
    { scroll: 'down' },
    { expectDisabled: 'Transfer stock' },

    // Over-quantity refusal on a fresh form. 999999 is above any fixture's stock,
    // so the check does not depend on the starting quantity. Leave the transfer
    // route first: opening the SAME deep link while its form is mounted is a no-op
    // (measured 2026-11-15), so the previous same-location form and its scroll
    // position survived and `expect "From location"` read a clipped screen.
    { open: 'inventoryai://dashboard' },
    { wait: 700 },
    { open: 'inventoryai://transfer' },
    { expect: 'From location' },
    { pick: { field: 'Choose a product…', sheet: 'Product', option: '{{productName}}' } },
    { pick: { field: 'Choose the source…', sheet: 'From location', option: '{{source}}' } },
    { pick: { field: 'Choose the destination…', sheet: 'To location', option: '{{destination}}' } },
    { type: { value: '999999', into: 'Quantity' } },
    { scroll: 'up' },
    { expect: 'available to move' },
    { scroll: 'down' },
    { expectDisabled: 'Transfer stock' },

    { findProduct: { sku: '{{sku}}' } },
    { tap: 'Stock Out' },
    { pick: { field: 'Choose a location…', sheet: 'Location', option: '{{source}}' } },
    { type: { value: '1', into: 'Quantity' } },
    { type: { value: 'PHONE-TRF-{{runId}}-OUT', into: 'Reference (optional)' } },
    { tap: 'Remove stock' },
    { movement: { deltas: [-1] } },
    { tap: 'OK' },
    { shot: 'transfer-done' },
  ],
};

/**
 * The Draft PO force-stop proof, end to end.
 *
 * The local proxy force-stops the app after it has fully received the Draft PO request and before
 * it forwards that request upstream. The journey then asserts the process is gone, cold-starts the
 * dev bundle, proves the saved attempt was restored, resumes it, and checks the database for exactly
 * one DRAFT carrying the captured key and body.
 *
 * Needs `--allow-writes`, `--supplier`, `--location`, `--product1`, `--product2`, `--proxy-log` and
 * `--database`. The proxy must be running with `--kill-package=com.inventoryai.app`.
 */
const draftResume = {
  id: 'draft-resume',
  summary:
    'Submit a Draft PO, force-stop after the request, cold relaunch, resume the same key/body, and prove one DRAFT.',
  steps: [
    { open: 'inventoryai://purchase-orders/from-restock' },
    { expect: 'Draft purchase order from restock' },
    { pick: { field: 'Choose a supplier…', sheet: 'Supplier', option: '{{supplier}}' } },
    { pick: { field: 'Choose a location…', sheet: 'Receiving location', option: '{{location}}' } },
    { expect: '{{product1}}' },
    { tap: '{{product1}}' },
    { tap: '{{product2}}' },
    { scroll: 'down' },
    { expect: 'Create draft order (2 items)' },
    { tap: 'Create draft order (2 items)' },
    { expectStopped: { package: 'com.inventoryai.app', proxyLog: '{{proxyLog}}' } },
    { relaunch: 'inventoryai://purchase-orders/from-restock' },
    { expect: 'An unfinished draft attempt was restored' },
    { scroll: 'down' },
    { expect: 'Resume draft creation (2 items)' },
    { tap: 'Resume draft creation (2 items)' },
    { expect: 'Purchase Order' },
    { expect: 'PO-' },
    { shot: 'draft-po-resumed' },
    { verifyDraftResume: { database: '{{database}}' } },
  ],
};

export const JOURNEYS = Object.freeze([smoke, label, draft, stock, transfer, draftResume]);

/** Journeys that write to the tenant, and are therefore never part of `--all`. */
export const WRITE_JOURNEYS = Object.freeze(['draft', 'stock', 'transfer', 'draft-resume']);

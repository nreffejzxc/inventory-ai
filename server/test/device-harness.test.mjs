/**
 * The device-acceptance harness's own checks.
 *
 * WHY THESE EXIST. The harness drives a real phone over adb and decides pass/fail from the screen's
 * accessibility tree. Every judgement it makes — "this text is on screen", "this step failed",
 * "this run exited 2 rather than 0" — is a place where a mistake turns a broken build into a green
 * report, which is worse than having no harness. So the judgements are pure functions here, asserted
 * directly, with must-fail controls beside them: a matcher that cannot miss and an exit code that
 * cannot be 1 would both pass a happy-path test.
 *
 * WHAT THESE DO NOT PROVE: that the phone is connected, that the app renders, or that a journey
 * passes on hardware. Those need the device, and `scripts/device/run.mjs` records them.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeListState,
  disabledTarget,
  escapeInputText,
  exitCodeFor,
  fieldBelow,
  fillTemplate,
  findNodes,
  findProductRow,
  findTapTarget,
  hasSheetClose,
  isBlankDump,
  isUnstableDump,
  judgeDataRows,
  judgeSettled,
  looksAtDevLauncher,
  looksLikePicker,
  looksSessionExpired,
  looksSignedOut,
  optionTarget,
  parseDump,
  parseMovements,
  quoteForDeviceShell,
  rowsMatching,
  summariseRun,
  unfilledPlaceholders,
  validateJourneys,
} from '../../scripts/device/lib.mjs';
import { INVENTORY_ROW, JOURNEYS, PRODUCT_ROW } from '../../scripts/device/journeys.mjs';

// A slice of a real `uiautomator dump` from the app (the shape matters: attributes are one long
// line per node and a node's label may be `text` or `content-desc`).
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.inventoryai.app" content-desc="" clickable="false" bounds="[0,0][1080,2208]">
    <node index="0" text="Inventory AI" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" bounds="[72,372][1008,468]" />
    <node index="1" text="Receive Stock" resource-id="" class="android.widget.Button" content-desc="" clickable="true" bounds="[48,2022][1032,2160]" />
    <node index="2" text="" resource-id="" class="android.widget.Button" content-desc="Scan barcode" clickable="true" bounds="[900,100][1020,220]" />
  </node>
</hierarchy>`;

describe('the screen reader turns a dump into tappable nodes', () => {
  it('reads text, content-desc and bounds from a real dump shape', () => {
    const { nodes } = parseDump(DUMP);

    // Three LABELLED nodes. The unlabelled root container is deliberately not a node: a journey
    // can neither assert nor tap it, and keeping it would let "the screen has nodes" be true of an
    // empty screen.
    assert.equal(nodes.length, 3);
    const title = nodes.find((n) => n.label === 'Inventory AI');
    assert.deepEqual(title.bounds, { x1: 72, y1: 372, x2: 1008, y2: 468 });
    // A tap goes to the middle of the node, not its corner.
    assert.deepEqual(title.center, { x: 540, y: 420 });
  });

  it('finds a control by its content-desc, which is how the app labels icon buttons', () => {
    const { nodes } = parseDump(DUMP);

    const scan = findNodes(nodes, 'Scan barcode');

    assert.equal(scan.length, 1);
    assert.equal(scan[0].clickable, true);
  });

  it('does not invent a match for text that is not on screen', () => {
    const { nodes } = parseDump(DUMP);

    // The control: a matcher that cannot miss would pass every journey.
    assert.deepEqual(findNodes(nodes, 'Not On This Screen'), []);
  });

  it('prefers an exact match over a longer label that contains it', () => {
    // "Receive Stock" exists twice in the real app (a heading and a button). An exact search must
    // return the exact one, not the first substring hit.
    const { nodes } = parseDump(DUMP);

    const exact = findNodes(nodes, 'Receive Stock', { exact: true });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].bounds.y1, 2022);

    const loose = findNodes(nodes, 'Receive', { exact: false });
    assert.equal(loose.length, 1);
  });
});

/** A slice of the purchase-order form: two labels, two fields, and one decoy field above them. */
const FORM = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Search products" class="android.widget.EditText" clickable="true" bounds="[0,100][1080,200]" />
  <node index="1" text="Quantity ordered *" class="android.widget.TextView" clickable="false" bounds="[0,2112][1080,2166]" />
  <node index="2" text="e.g. 24" class="android.widget.EditText" clickable="true" bounds="[0,2184][1080,2280]" />
  <node index="3" text="Notes (optional)" class="android.widget.TextView" clickable="false" bounds="[0,2400][1080,2454]" />
  <node index="4" text="Add a note" class="android.widget.EditText" clickable="true" bounds="[0,2472][1080,2568]" />
</hierarchy>`;

describe('a stock movement is checked against the app\'s own arithmetic', () => {
  it('reads one movement and its difference', () => {
    const [move] = parseMovements('Done. Everyday Battery at Shop Front: 33 → 38');
    assert.equal(move.from, 33);
    assert.equal(move.to, 38);
    assert.equal(move.diff, 5);
  });

  it('reads both legs of a transfer, in the order the app prints them', () => {
    const moves = parseMovements(
      'Done. Battery moved from Shop Front to Main Warehouse.\nShop Front: 1,033 → 1,032\nMain Warehouse: 32 → 33',
    );
    assert.equal(moves.length, 2);
    assert.deepEqual(moves.map((m) => m.diff), [-1, 1]);
    assert.equal(moves[0].from, 1033);
  });

  it('finds nothing in text that is not a movement (controls)', () => {
    assert.deepEqual(parseMovements('Done. 5 items added'), []);
    assert.deepEqual(parseMovements('33 → 38'), []);
    assert.deepEqual(parseMovements(''), []);
    assert.deepEqual(parseMovements(null), []);
  });

  it('accepts only a whole-number delta list on the movement verb', () => {
    const ok = validateJourneys([
      { id: 'a', summary: 's', steps: [{ movement: { deltas: [5] } }] },
      { id: 'b', summary: 's', steps: [{ movement: { deltas: [-1, 1] } }] },
    ]);
    assert.deepEqual(ok, []);

    const bad = validateJourneys([
      { id: 'c', summary: 's', steps: [{ movement: { deltas: [] } }] },
      { id: 'd', summary: 's', steps: [{ movement: { deltas: [1.5] } }] },
      { id: 'e', summary: 's', steps: [{ movement: 5 }] },
    ]);
    assert.equal(bad.length, 3, bad.join('; '));
    assert.ok(bad.every((p) => /movement/.test(p)), bad.join('; '));
  });
});

describe('journey placeholders are filled from the run\'s flags', () => {
  it('substitutes a named value', () => {
    assert.equal(fillTemplate('{{source}}', { source: 'Shop Front' }), 'Shop Front');
  });

  it('leaves an unknown placeholder visible instead of blanking it', () => {
    // A blank would read as "tap nothing" and become a mysterious failure later; leaving the
    // marker lets the runner report exactly which flag is missing.
    assert.equal(fillTemplate('{{destination}}', {}), '{{destination}}');
    assert.deepEqual(unfilledPlaceholders('go to {{destination}}'), ['destination']);
    assert.deepEqual(unfilledPlaceholders('Shop Front'), []);
  });
});

describe('a form field is found by its label, not by whatever has focus', () => {
  const nodes = parseDump(FORM).nodes;

  it('returns the edit box directly below its label', () => {
    const field = fieldBelow(nodes, 'Quantity ordered *');
    assert.ok(field, 'the quantity field was not found');
    assert.equal(field.bounds.y1, 2184);
    // Not the decoy text box above the form, which is nearer the top of the screen.
    assert.notEqual(field.bounds.y1, 100);
  });

  it('keeps two labels on the same screen apart', () => {
    assert.equal(fieldBelow(nodes, 'Notes (optional)').bounds.y1, 2472);
  });

  it('finds nothing when the label is absent or has no field under it (controls)', () => {
    assert.equal(fieldBelow(nodes, 'Expected date (optional)'), null);
    assert.equal(fieldBelow(nodes, ''), null);
  });

  it('accepts a target for the type verb, and rejects an empty one', () => {
    const ok = validateJourneys([
      { id: 'x', summary: 's', steps: [{ type: { value: '1', into: 'Quantity ordered' } }] },
    ]);
    assert.deepEqual(ok, []);

    const bad = validateJourneys([
      { id: 'a', summary: 's', steps: [{ type: { value: '' } }] },
      { id: 'b', summary: 's', steps: [{ type: { value: '1', typo: 'x' } }] },
      { id: 'c', summary: 's', steps: [{ type: 42 }] },
    ]);
    assert.equal(bad.length, 3, bad.join('; '));
    assert.ok(bad.every((p) => /type needs text/.test(p)), bad.join('; '));
  });
});

/**
 * A real dump taken during a scroll: the label and clickability are right, `y2` is above `y1`.
 * This is the exact shape that sent a tap into the quantity field (centre computed at y=1653).
 */
const UNSTABLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Quantity ordered *" class="android.widget.TextView" clickable="false" bounds="[99,1164][981,1218]" />
  <node index="1" text="Create draft order" class="android.widget.Button" clickable="true" bounds="[48,1863][1032,1443]" />
</hierarchy>`;

/**
 * A selector field, as the app actually renders it: the visible words are a Text node INSIDE the
 * Pressable that opens the sheet, and the Pressable's own label carries the same words plus a
 * chevron. Tapping the text node reports success and opens nothing.
 */
const SELECTOR = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Location *" class="android.widget.TextView" clickable="false" bounds="[48,666][1032,720]" />
  <node index="1" text="Choose a location…, ▾" class="android.widget.Button" clickable="true" bounds="[48,738][1032,876]">
    <node index="0" text="Choose a location…" class="android.widget.TextView" clickable="false" bounds="[76,742][420,871]" />
    <node index="1" text="▾" class="android.widget.TextView" clickable="false" bounds="[950,774][1010,839]" />
  </node>
</hierarchy>`;

describe('a deep link survives the device shell', () => {
  it('quotes the whole URL, so its query string is not split at the ampersand', () => {
    const url = 'inventoryai://stock-in?productId=abc&lock=1';
    const quoted = quoteForDeviceShell(url);
    assert.equal(quoted, `'${url}'`);
    // The control: the unquoted form is what the phone's shell splits, and the second half of the
    // query never reaches the app.
    assert.notEqual(url, quoted);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  });

  it('escapes a quote inside the value rather than ending the string early', () => {
    assert.equal(quoteForDeviceShell("it's"), String.raw`'it'\''s'`);
  });

  it('recognises the labels that open a picker (controls included)', () => {
    assert.equal(looksLikePicker('Choose a location…'), true);
    assert.equal(looksLikePicker('Choose a supplier'), true);
    assert.equal(looksLikePicker('Add stock'), false);
    assert.equal(looksLikePicker(''), false);
  });
});

const DISABLED = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Transfer stock" class="android.widget.Button" clickable="true" enabled="false" bounds="[48,1930][1032,2068]" />
  <node index="1" text="Add stock" class="android.widget.Button" clickable="true" bounds="[48,1930][1032,2068]" />
</hierarchy>`;

describe('a refusal is pinned to the disabled control, not only its warning', () => {
  const nodes = parseDump(DISABLED).nodes;

  it('reads Android enabled state, treating a missing attribute as enabled', () => {
    assert.equal(nodes.find((node) => node.label === 'Transfer stock').enabled, false);
    assert.equal(nodes.find((node) => node.label === 'Add stock').enabled, true);
  });

  it('returns only an explicitly disabled node', () => {
    assert.equal(disabledTarget(nodes, 'Transfer stock').enabled, false);
    assert.equal(disabledTarget(nodes, 'Add stock'), null);
  });

  it('returns null for a label that is not on screen (control)', () => {
    assert.equal(disabledTarget(nodes, 'Remove stock'), null);
  });

  it('accepts the verb in a journey and refuses an empty label', () => {
    assert.deepEqual(
      validateJourneys([{ id: 'r', summary: 's', steps: [{ expectDisabled: 'Transfer stock' }] }]),
      []
    );
    assert.match(
      validateJourneys([{ id: 'r', summary: 's', steps: [{ expectDisabled: '' }] }]).join(' '),
      /expectDisabled/
    );
  });
});

describe('the transfer journey exercises both refusals and both directions', () => {
  const transfer = JOURNEYS.find((journey) => journey.id === 'transfer');
  const labels = transfer.steps.map((step) => Object.keys(step)[0]);
  const text = JSON.stringify(transfer.steps);

  it('has the forward and reverse transfers', () => {
    assert.equal(labels.filter((verb) => verb === 'movement').length, 4, 'stock-in, two transfers, stock-out');
    assert.equal(text.includes('PHONE-TRF-{{runId}}-F'), true);
    assert.equal(text.includes('PHONE-TRF-{{runId}}-R'), true);
  });

  it('checks the same-location warning and the over-quantity warning, each with a disabled submit', () => {
    assert.equal(text.includes('Choose two different locations'), true);
    assert.equal(text.includes('available to move'), true);
    assert.equal(labels.filter((verb) => verb === 'expectDisabled').length, 2);

    // The warning is a banner above the form. Typing leaves the form scrolled to
    // Quantity; the banner is outside the accessibility tree until the journey
    // scrolls to the top, and the submit is at the bottom. Pin that order, or a
    // future edit reintroduces the false failure measured on 2026-11-15.
    const disabledAt = labels.flatMap((verb, index) => (verb === 'expectDisabled' ? [index] : []));
    for (const index of disabledAt) {
      assert.deepEqual(transfer.steps[index - 1], { scroll: 'down' });
      assert.match(Object.keys(transfer.steps[index - 2])[0], /^expect$/);
      assert.deepEqual(transfer.steps[index - 3], { scroll: 'up' });
    }

    // Opening the same transfer deep link while the form is mounted does not reset it.
    // The over-quantity check must leave the route first; otherwise it inherits the
    // same-location form and its scroll position (measured 2026-11-15).
    const dashboardAt = transfer.steps.findIndex((step) => step.open === 'inventoryai://dashboard');
    const overAt = transfer.steps.findIndex((step) => step.type?.value === '999999');
    assert.ok(dashboardAt > disabledAt[0], 'the over-quantity form must leave the mounted transfer route');
    assert.ok(dashboardAt < overAt, 'the dashboard reset must happen before the over-quantity form');
  });

  it('carries the references the database verifier reconciles', () => {
    for (const suffix of ['IN', 'F', 'R', 'OUT']) {
      assert.equal(text.includes(`PHONE-TRF-{{runId}}-${suffix}`), true, suffix);
    }
  });
});

describe('a selector field is tapped on the control, not on its words', () => {
  const nodes = parseDump(SELECTOR).nodes;

  it('prefers the clickable container that carries the words plus a chevron', () => {
    const target = findTapTarget(nodes, 'Choose a location…');
    assert.ok(target, 'the selector was not found at all');
    assert.equal(target.clickable, true);
    assert.equal(target.bounds.y1, 738);
  });

  it('still returns a plain label when nothing clickable contains it (control)', () => {
    const target = findTapTarget(nodes, 'Location *');
    assert.equal(target.clickable, false);
    assert.equal(target.bounds.y1, 666);
  });

  it('honours an exact request, which is about the heading itself', () => {
    assert.equal(findTapTarget(nodes, 'Choose a location…', { exact: true }).clickable, false);
  });
});

describe('a dump taken mid-scroll is read for its words, never for its geometry', () => {
  const nodes = parseDump(UNSTABLE).nodes;

  it('marks an inverted box instead of inventing a centre', () => {
    const button = nodes.find((node) => node.label === 'Create draft order');
    assert.equal(button.brokenBounds, true);
    assert.equal(nodes.find((node) => node.label === 'Quantity ordered *').brokenBounds, false);
  });

  it('refuses the inverted node as a tap target, and says so', () => {
    assert.equal(findTapTarget(nodes, 'Create draft order'), null);
    // Control: the stable label on the same dump is still tappable, so the rule is about the box.
    assert.ok(findTapTarget(nodes, 'Quantity ordered'));
  });

  it('is distinguishable from a stable dump, so the reader can retry', () => {
    assert.equal(isUnstableDump(UNSTABLE), true);
    assert.equal(isUnstableDump(DUMP), false);
    // A blank dump is served by the existing rule, not this one.
    assert.equal(isUnstableDump('<hierarchy rotation="0"></hierarchy>'), true);
  });
});

describe('a session the server rejects is not a signed-out app', () => {
  it('is recognised by the app\'s own banner', () => {
    const nodes = parseDump(
      `<hierarchy rotation="0"><node text="Inventory" class="android.widget.TextView" clickable="false" bounds="[0,0][10,10]" />` +
        `<node text="Something went wrong" class="android.widget.TextView" clickable="false" bounds="[0,20][10,30]" />` +
        `<node text="Session expired — please sign in again" class="android.widget.TextView" clickable="false" bounds="[0,40][10,50]" /></hierarchy>`,
    ).nodes;

    assert.equal(looksSessionExpired(nodes), true);
  });

  it('is not the login screen, and an ordinary error is not this one (controls)', () => {
    assert.equal(looksSessionExpired(parseDump(DUMP).nodes), false);
    const other = parseDump(
      `<hierarchy rotation="0"><node text="Couldn't load products" class="android.widget.TextView" clickable="false" bounds="[0,0][10,10]" /></hierarchy>`,
    ).nodes;
    assert.equal(looksSessionExpired(other), false);
  });
});

describe('a signed-out app is a blocked run, not a failed one', () => {
  // The login screen's own labels, taken from the real dump that ended the first harness run
  // (2026-10-21): the session had expired, and the runner reported `expect "Overview"` as a
  // FAILURE — which reads as an app defect when it is really a precondition.
  const login = parseDump(
    `<hierarchy rotation="0">
      <node text="Welcome back" class="android.widget.TextView" bounds="[147,690][933,768]" clickable="false" />
      <node text="Email *" class="android.widget.TextView" bounds="[147,1074][933,1128]" clickable="false" />
      <node text="role@example.invalid" class="android.widget.EditText" bounds="[147,1146][933,1281]" clickable="true" />
      <node text="Password *" class="android.widget.TextView" bounds="[147,1329][933,1383]" clickable="false" />
      <node text="Sign In" class="android.widget.Button" bounds="[147,1584][933,1722]" clickable="true" />
    </hierarchy>`,
  ).nodes;

  it('recognises the login screen', () => {
    assert.equal(looksSignedOut(login), true);
  });

  it('does not mistake the dashboard for a signed-out screen', () => {
    const dashboard = parseDump(
      `<hierarchy rotation="0">
        <node text="Overview" class="android.widget.TextView" bounds="[147,536][933,602]" clickable="false" />
        <node text="Sign out" class="android.widget.Button" bounds="[147,1900][933,2000]" clickable="true" />
      </hierarchy>`,
    ).nodes;

    assert.equal(looksSignedOut(dashboard), false);
  });
});

describe('the Expo dev launcher is not the app', () => {
  // The real labels from the 2026-10-22 run that reported `expect "Overview"` as a FAILURE while
  // the dev launcher was in front: Metro had been restarted, the dev client came back on its
  // launcher screen, and a deep link cannot route into an app that is not running.
  const launcher = parseDump(
    `<hierarchy rotation="0">
      <node text="Inventory AI" class="android.widget.TextView" clickable="false" bounds="[0,0][10,10]" />
      <node text="Development Build" class="android.widget.TextView" clickable="false" bounds="[0,20][10,30]" />
      <node text="DEVELOPMENT SERVERS" class="android.widget.TextView" clickable="false" bounds="[0,40][10,50]" />
      <node text="Start a local development server with:" class="android.widget.TextView" clickable="false" bounds="[0,60][10,70]" />
      <node text="npx expo start" class="android.widget.TextView" clickable="false" bounds="[0,80][10,90]" />
    </hierarchy>`,
  ).nodes;

  it('is recognised, so the runner starts the app instead of failing a screen', () => {
    assert.equal(looksAtDevLauncher(launcher), true);
  });

  it('does not mistake the app for the launcher (controls)', () => {
    assert.equal(looksAtDevLauncher(parseDump(DUMP).nodes), false);
    // One launcher word alone is not enough — an app screen is allowed to say "Development Build".
    const oneWord = parseDump(
      `<hierarchy rotation="0"><node text="Development Build" class="android.widget.TextView" clickable="false" bounds="[0,0][10,10]" /></hierarchy>`,
    ).nodes;
    assert.equal(looksAtDevLauncher(oneWord), false);
    assert.equal(looksAtDevLauncher([]), false);
  });

  it('the runner starts the app, and blocks rather than judging it if that fails', () => {
    const runner = readFileSync(new URL('../../scripts/device/run.mjs', import.meta.url), 'utf8');
    const adb = readFileSync(new URL('../../scripts/device/adb.mjs', import.meta.url), 'utf8');

    assert.match(runner, /looksAtDevLauncher\(screen\.nodes\)/);
    assert.match(runner, /device\.openDevClient\(/);
    // The launcher is left by expo-dev-client's own link to a named server — not by `am start -n`
    // (measured: that lands back on DevLauncherActivity) and not by a tap at coordinates.
    assert.match(adb, /export function openDevClient\(/);
    assert.match(adb, /inventoryai:\/\/expo-development-client\/\?url=/);
    // The still-on-the-launcher path exits 2 BEFORE any journey, so nothing is judged about the app.
    const block = runner.slice(runner.indexOf('looksAtDevLauncher(screen.nodes)'), runner.indexOf('let worst'));
    assert.match(block, /cannot check/);
    assert.match(block, /process\.exit\(2\)/);
  });
});

describe('a blank or stale dump is never read as a screen', () => {
  it('treats an empty file as no screen (a failed dump leaves the previous file behind)', () => {
    assert.equal(isBlankDump(''), true);
    assert.equal(isBlankDump('   \n'), true);
    assert.equal(isBlankDump('<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>'), true);
  });

  it('accepts a dump that carries nodes', () => {
    assert.equal(isBlankDump(DUMP), false);
  });
});

describe('a typed value is filled before it reaches the form', () => {
  it('substitutes {{runId}} in a value, not only in a label', () => {
    assert.equal(
      fillTemplate('PHONE-TRF-{{runId}}-IN', { runId: '2026-11-15T03-05-40-157Z' }),
      'PHONE-TRF-2026-11-15T03-05-40-157Z-IN'
    );
  });

  it('resolves the value before typing it, and blocks when a flag is missing', () => {
    const runner = readFileSync(new URL('../../scripts/device/run.mjs', import.meta.url), 'utf8');
    const resolveAt = runner.indexOf('resolveStepText(spec.value, ctx)');
    const typeAt = runner.indexOf('device.typeText(escapeInputText(spec.value)');
    assert.ok(resolveAt > 0, 'the type branch does not resolve its value');
    assert.ok(typeAt > resolveAt, 'the value is typed before placeholders are resolved');
    assert.match(runner.slice(resolveAt, typeAt), /status: 'blocked'/);
  });
});

describe('typing survives the device shell', () => {
  it('encodes a space as %s, which is what `input text` expects', () => {
    assert.equal(escapeInputText('Classic Mug'), 'Classic%sMug');
  });

  it('leaves an ordinary alphanumeric password alone', () => {
    assert.equal(escapeInputText('RoleTest2026'), 'RoleTest2026');
  });

  it('quotes the shell characters that would otherwise run on the device', () => {
    // A quote or a backtick would end the command instead of being typed.
    assert.equal(escapeInputText("it's"), "it\\'s");
    assert.equal(escapeInputText('a`b'), 'a\\`b');
    assert.equal(escapeInputText('a\\b'), 'a\\\\b');
  });
});

describe('the run report cannot claim more than happened', () => {
  const step = (status, title) => ({ title, status, detail: '', durationMs: 1 });

  it('exits 0 only when every step passed', () => {
    assert.equal(exitCodeFor([step('pass'), step('pass')]), 0);
  });

  it('exits 1 when a step failed', () => {
    assert.equal(exitCodeFor([step('pass'), step('fail')]), 1);
  });

  it('exits 2 — could not check — when a step was blocked, even with no failures', () => {
    assert.equal(exitCodeFor([step('pass'), step('blocked')]), 2);
    // A failure outranks a block: something was wrong, not merely unreachable.
    assert.equal(exitCodeFor([step('blocked'), step('fail')]), 1);
  });

  it('names the journey, every step and the failure reason in the markdown', () => {
    const md = summariseRun({
      journey: 'smoke',
      startedAt: '2026-10-21T00:00:00.000Z',
      device: 'CPH1969',
      steps: [
        { title: 'Dashboard renders', status: 'pass', durationMs: 412 },
        { title: 'Inventory renders', status: 'fail', detail: 'expected "Inventory" within 15000ms', durationMs: 15000 },
      ],
    });

    assert.match(md, /smoke/);
    assert.match(md, /\| Dashboard renders \| pass \| 412 \|/);
    assert.match(md, /\| Inventory renders \| FAIL \| 15000 \| expected "Inventory" within 15000ms/);
    // The summary line must not say pass when a step failed.
    assert.match(md, /overall: FAIL \(exit 1\)/);
    assert.doesNotMatch(md, /overall: pass/i);
  });
});

/**
 * A screen that shows no data is not a screen that passed.
 *
 * The 2026-10-22 reproduction reported 17/17 on an app where every request was refused `401`: all
 * 17 assertions were screen headings, and a heading renders above an empty list just as well as
 * above a full one. These cases are the assertion that closes that hole — and each one is paired
 * with the state it must REJECT, because a data check that cannot miss would restore the green
 * report without restoring the evidence.
 */
const listDump = (...labels) =>
  `<hierarchy rotation="0">${labels
    .map(
      (label, index) =>
        `<node text="${label}" class="android.widget.TextView" clickable="false" bounds="[0,${index * 20}][10,${index * 20 + 10}]" />`,
    )
    .join('')}</hierarchy>`;

describe('a list screen must show data, not just its own heading', () => {
  const withRows = parseDump(
    listDump(
      'Inventory',
      'Low stock',
      'Out of stock',
      'Widget',
      'Shop Front · 3 available · 5 on hand',
      'Gadget',
      'Shop Front · 1,281 available · 1,294 on hand',
    ),
  ).nodes;

  it('passes on rows the client cannot invent', () => {
    const verdict = judgeDataRows(withRows, { what: 'stock rows', match: INVENTORY_ROW });

    assert.equal(verdict.verdict, 'rows');
    assert.equal(verdict.rows.length, 2);
  });

  it('counts rows against `min` rather than passing on any match', () => {
    const two = judgeDataRows(withRows, { match: INVENTORY_ROW, min: 2 });
    const three = judgeDataRows(withRows, { match: INVENTORY_ROW, min: 3 });

    assert.equal(two.verdict, 'rows');
    assert.equal(three.verdict, 'absent');
  });

  it('fails a screen showing its error state (the refused-session defect)', () => {
    const refused = parseDump(
      listDump('Inventory', 'Something went wrong', 'Session expired — please sign in again', 'Try again'),
    ).nodes;
    const verdict = judgeDataRows(refused, { match: INVENTORY_ROW });

    assert.equal(verdict.verdict, 'error');
    assert.match(verdict.detail, /Session expired/);
  });

  it('lets a session refusal outrank stale rows left from an earlier load (must trip)', () => {
    // The app keeps its last page in memory, so an error can arrive with rows still on screen.
    // Counting rows first would report data on a screen the server has already refused.
    const stale = parseDump(
      listDump('Inventory', 'Shop Front · 3 available · 5 on hand', 'Session expired — please sign in again'),
    ).nodes;
    const verdict = judgeDataRows(stale, { match: INVENTORY_ROW });

    assert.equal(verdict.verdict, 'error');
    assert.equal(verdict.rows.length, 1);
  });

  it('blocks an empty tenant instead of passing it, and never calls it data', () => {
    const empty = parseDump(
      listDump('Inventory', 'Nothing to show', 'No stock records yet — stock in a product at a location to create one.'),
    ).nodes;

    assert.equal(judgeDataRows(empty, { match: INVENTORY_ROW }).verdict, 'empty');
    assert.equal(describeListState(empty).state, 'empty');
  });

  it('recognises every empty-state title the app actually renders (copy parity)', () => {
    // MEASURED 2026-10-26, on an empty production tenant: Inventory prints "Nothing to show" and the
    // harness read it correctly, while Products prints "No products found" — the same fact in the
    // app's own words — and the run FAILED the step. The fix is a pattern, so the pattern has to be
    // tied to the copy the screens carry, or the next per-screen title reintroduces the false
    // failure. This reads `title`/`emptyTitle` values out of the mobile sources and requires each
    // one to be recognised; a rename that breaks the harness now breaks here first.
    const appDir = join(fileURLToPath(new URL('../..', import.meta.url)), 'mobile', 'app');
    const titles = new Set();

    for (const name of readdirSync(appDir, { recursive: true })) {
      if (!String(name).endsWith('.tsx')) continue;
      const source = readFileSync(join(appDir, String(name)), 'utf8');
      for (const match of source.matchAll(/(?:emptyTitle|title)="([^"]+)"/g)) {
        if (/^(Nothing|No)\b/.test(match[1])) titles.add(match[1]);
      }
    }

    // A scan that silently found nothing would pass every assertion below it.
    assert.ok(titles.size >= 8, `expected the app's empty-state titles, found ${titles.size}`);

    for (const title of titles) {
      const nodes = parseDump(listDump('Some list', title)).nodes;
      assert.equal(describeListState(nodes).state, 'empty', `"${title}" must read as the empty state`);
    }
  });

  it('does not mistake a loading screen for an empty one', () => {
    const loading = parseDump(listDump('Inventory', 'Loading inventory…')).nodes;

    assert.equal(judgeDataRows(loading, { match: INVENTORY_ROW }).verdict, 'pending');
  });

  it('reports nothing matched when the screen is merely chrome (control)', () => {
    // The exact screen the reproduction run judged "passed": heading, search, chips, no rows.
    const chrome = parseDump(
      listDump('Inventory', 'Scan', 'Purchase Orders', 'Search by product name, SKU or barcode…', 'Low stock'),
    ).nodes;

    assert.equal(judgeDataRows(chrome, { match: INVENTORY_ROW }).verdict, 'absent');
    assert.deepEqual(rowsMatching(chrome, INVENTORY_ROW), []);
  });

  it('ignores a pattern that is not a regular expression (control)', () => {
    assert.deepEqual(rowsMatching(withRows, 'available'), []);
  });

  it('judges a screen that may legitimately be empty by whether it errored', () => {
    // The other five smoke screens (purchase orders, suppliers, restock, assistant, audit) have no
    // guaranteed rows, so they are covered by "finished loading without an error" instead.
    const clean = parseDump(listDump('Purchase Orders', 'No purchase orders yet')).nodes;
    const failed = parseDump(
      listDump('Purchase Orders', 'Unable to load. Check your connection and try again.', 'Try again'),
    ).nodes;
    const refused = parseDump(listDump('Suppliers', 'Session expired — please sign in again')).nodes;
    const loading = parseDump(listDump('Restock', 'Loading…')).nodes;

    assert.equal(judgeSettled(clean).verdict, 'clean');
    assert.equal(judgeSettled(failed).verdict, 'error');
    assert.equal(judgeSettled(refused).verdict, 'error');
    // Out of time is not a verdict: the runner reports it as BLOCKED, never as a pass.
    assert.equal(judgeSettled(loading).verdict, 'loading');
  });

  it('does not count the search box as a product row (must trip)', () => {
    // Measured on the first run that used the products pattern: `Search by name, SKU or barcode…`
    // contains "SKU ", so an unanchored pattern found a row on a screen with no rows and reported
    // chrome as evidence. The placeholder is exactly what a broken list still renders.
    const placeholderOnly = parseDump(
      listDump('Products', 'Search by name, SKU or barcode…', 'New product', 'Scan a barcode'),
    ).nodes;
    const realRows = parseDump(
      listDump('Products', 'Search by name, SKU or barcode…', 'SKU SEEDSKU-0 · Barcode 2000053337540'),
    ).nodes;

    assert.deepEqual(rowsMatching(placeholderOnly, PRODUCT_ROW), []);
    assert.equal(judgeDataRows(placeholderOnly, { match: PRODUCT_ROW }).verdict, 'absent');
    assert.equal(rowsMatching(realRows, PRODUCT_ROW).length, 1);
  });

  it('counts a product row whose meta starts with its category (must trip)', () => {
    // 2026-10-22, on the phone: the products screen showed two rows and the harness reported
    // `expected product rows, but nothing matches`, because the meta line is built from the parts
    // a product HAS (`SKU · Category · Barcode`) and this tenant's products have a category and no
    // SKU — so it reads `Hardware · Barcode 2000053337540`. Every one of these is a row the screen
    // really prints; the placeholder is not.
    const shapes = [
      'SKU SEEDSKU-0 · Barcode 2000053337540',
      'Hardware · Barcode 2000053337540',
      'Barcode 2000053337540',
      'SKU SEEDSKU-0',
      'Hardware · SKU SEEDSKU-0 · Barcode 2000053337540',
    ];
    for (const label of shapes) {
      assert.equal(PRODUCT_ROW.test(label), true, `should count as a row: ${label}`);
    }

    // Still not the search box, nor a meta line that lost its barcode digits.
    assert.equal(PRODUCT_ROW.test('Search by name, SKU or barcode…'), false);
    assert.equal(PRODUCT_ROW.test('Hardware · Barcode'), false);
    assert.equal(PRODUCT_ROW.test('All categories'), false);
  });
});

/**
 * A products screen as the app renders it: a heading, the search box, and two cards whose meta lines
 * carry SKUs that share a prefix (`SMOKE-1`, `SMOKE-10`).
 */
const PRODUCT_LIST = `<hierarchy rotation="0">
  <node text="Products" class="android.widget.TextView" clickable="false" bounds="[48,120][400,180]" />
  <node text="Search by name, SKU or barcode…" class="android.widget.EditText" clickable="true" bounds="[48,300][1032,390]" />
  <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[160,470][900,520]" />
  <node text="SKU SMOKE-1 · Barcode 2000053337540" class="android.widget.TextView" clickable="false" bounds="[160,530][900,570]" />
  <node text="Smoke Widget XL" class="android.widget.TextView" clickable="false" bounds="[160,700][900,750]" />
  <node text="SKU SMOKE-10 · Barcode 2000053337541" class="android.widget.TextView" clickable="false" bounds="[160,760][900,800]" />
</hierarchy>`;

describe('a product is found by SKU, so no run has to be told an internal id', () => {
  const { nodes } = parseDump(PRODUCT_LIST);

  it('reads the row for a SKU and the name printed above it', () => {
    const row = findProductRow(nodes, 'SMOKE-1');

    assert.ok(row, 'no row was found for SMOKE-1');
    assert.equal(row.meta.label, 'SKU SMOKE-1 · Barcode 2000053337540');
    // The name is a CANDIDATE until the detail screen prints it, and `pick` only ever searches
    // for a name that screen confirmed.
    assert.equal(row.name, 'Smoke Widget');
  });

  it('does not let a SKU match a longer one that starts with it (must trip)', () => {
    // `SMOKE-1` is a prefix of `SMOKE-10`. A substring match would open the wrong product, and on
    // a write journey that means moving stock on a product nobody asked about.
    assert.equal(findProductRow(nodes, 'SMOKE-1').meta.label.includes('SMOKE-10'), false);
    assert.equal(findProductRow(nodes, 'SMOKE-10').name, 'Smoke Widget XL');
    assert.equal(findProductRow(nodes, 'SMOKE-'), null);
    assert.equal(findProductRow(nodes, ''), null);
  });

  it('does not read the search placeholder as a product row (must trip)', () => {
    const empty = parseDump(
      `<hierarchy rotation="0">
        <node text="Search by name, SKU or barcode…" class="android.widget.EditText" clickable="true" bounds="[48,300][1032,390]" />
        <node text="No products found" class="android.widget.TextView" clickable="false" bounds="[48,600][1032,660]" />
      </hierarchy>`,
    ).nodes;

    assert.equal(findProductRow(empty, 'SKU'), null);
    assert.equal(findProductRow(empty, 'SMOKE-1'), null);
  });
});

describe('a picker option is chosen exactly, or not at all', () => {
  const sheet = parseDump(
    `<hierarchy rotation="0">
      <node text="Product" class="android.widget.TextView" clickable="false" bounds="[48,1500][400,1560]" />
      <node text="Search…" class="android.widget.EditText" clickable="true" bounds="[48,1600][1032,1690]" />
      <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1720][900,1770]" />
      <node text="Smoke Widget XL" class="android.widget.TextView" clickable="false" bounds="[48,1800][900,1850]" />
    </hierarchy>`,
  ).nodes;

  it('returns the single exact option', () => {
    assert.equal(optionTarget(sheet, 'Smoke Widget').label, 'Smoke Widget');
  });

  it('refuses a prefix and an absent option (must trip)', () => {
    // The failure this prevents is a transfer on the wrong product, which is a real inventory
    // movement: a "closest match" here would be a silent write to something nobody chose.
    assert.equal(optionTarget(sheet, 'Smoke'), null);
    assert.equal(optionTarget(sheet, 'Nothing Like This'), null);
    assert.equal(optionTarget(sheet, ''), null);
  });

  it("never chooses the sheet's own title, even when an option has that name", () => {
    // "Product" is the heading. A product may legitimately be called "Product" too, so the title
    // is excluded by identity: without that, a tap could land on the title, select nothing, and the
    // failure would surface two steps later as an empty field.
    const heading = sheet.find((node) => node.label === 'Product');

    assert.equal(optionTarget(sheet, 'Product'), heading);
    assert.equal(optionTarget(sheet, 'Product', { exclude: heading }), null);
  });

  it('refuses an ambiguous choice rather than taking the first', () => {
    const twice = parseDump(
      `<hierarchy rotation="0">
        <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1720][900,1770]" />
        <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1800][900,1850]" />
      </hierarchy>`,
    ).nodes;

    assert.equal(optionTarget(twice, 'Smoke Widget'), null);
  });

  it('never chooses the search box that now carries the option\'s text (must trip)', () => {
    // Measured on the phone 2026-10-26: after typing "Smoke Widget" into the sheet's search box,
    // the EditText's own text is that name, and counting it as an option made a one-product sheet
    // read as ambiguous.
    const typed = parseDump(
      `<hierarchy rotation="0">
        <node text="Product" class="android.widget.TextView" clickable="false" bounds="[36,1101][207,1167]" />
        <node text="Smoke Widget" class="android.widget.EditText" clickable="true" bounds="[48,1275][1032,1386]" />
        <node text="Smoke Widget" content-desc="Smoke Widget" class="android.view.ViewGroup" clickable="false" bounds="[0,1422][1080,1575]" />
        <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1467][1032,1530]" />
      </hierarchy>`,
    ).nodes;

    const chosen = optionTarget(typed, 'Smoke Widget');
    assert.ok(chosen, 'the only real option was refused');
    assert.equal(chosen.bounds.y1, 1422, 'the choice landed on the search box');
  });

  it('treats the duplicates of ONE row as one answer (must not refuse a real choice)', () => {
    // Measured on the phone 2026-10-26: a sheet with a single product exposed four "Smoke Widget"
    // nodes — the pressable and the text it contains — so counting nodes refused the only option
    // there was. The row on screen is the identity, not the node.
    const oneRow = parseDump(
      `<hierarchy rotation="0">
        <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1720][900,1770]" />
        <node text="" content-desc="Smoke Widget" class="android.widget.Button" clickable="true" bounds="[0,1700][1080,1800]" />
        <node text="Smoke Widget" class="android.widget.TextView" clickable="false" bounds="[48,1745][900,1795]" />
      </hierarchy>`,
    ).nodes;

    const chosen = optionTarget(oneRow, 'Smoke Widget');
    assert.ok(chosen, 'the only option on the sheet was refused');
    // The pressable is preferred, because that is the node that handles the tap.
    assert.equal(chosen.clickable, true);
  });
});

describe('a bottom sheet is recognised by its own close control', () => {
  it('sees the sheet and not the form label that carries the same word', () => {
    // Measured 2026-10-26: on a tenant with no suppliers the picker is disabled, so no sheet opened —
    // and `tapFirst` took the form's own "Supplier *" label as the heading, tapped a row under it,
    // and reported PASS. The purchase order then failed with "Supplier is required.", pointing the
    // next person at the wrong control.
    const formOnly = parseDump(
      `<hierarchy rotation="0">
        <node text="Supplier *" class="android.widget.TextView" clickable="false" bounds="[48,408][1032,462]" />
        <node text="Choose a supplier…" class="android.widget.TextView" clickable="false" bounds="[87,484][952,613]" />
      </hierarchy>`,
    ).nodes;
    const sheetOpen = parseDump(
      `<hierarchy rotation="0">
        <node text="Supplier" class="android.widget.TextView" clickable="false" bounds="[48,1500][400,1560]" />
        <node text="Done" class="android.widget.Button" clickable="true" bounds="[915,1500][1020,1560]" />
      </hierarchy>`,
    ).nodes;

    assert.equal(hasSheetClose(formOnly), false);
    assert.equal(hasSheetClose(sheetOpen), true);
    assert.equal(hasSheetClose([]), false);
  });
});

describe('the declared journeys are well formed', () => {
  it('never asks for an internal product id', () => {
    // The whole point of `findProduct`: an id is unreadable on a phone, so a journey that needs one
    // cannot be run by anybody who did not seed the tenant. A `{{product}}` marker here means a step
    // went back to the id, and `--product` no longer exists to fill it.
    for (const journey of JOURNEYS) {
      const text = JSON.stringify(journey.steps);
      assert.equal(text.includes('{{product}}'), false, `${journey.id} still needs an id`);
    }

    for (const id of ['label', 'stock', 'transfer']) {
      const journey = JOURNEYS.find((j) => j.id === id);
      assert.ok(journey, `${id} journey is missing`);
      assert.deepEqual(
        journey.steps[0],
        { findProduct: { sku: '{{sku}}' } },
        `${id} must open its product by SKU first`,
      );
    }

    // The transfer form's product picker filters on the NAME, so it needs the name the phone
    // read back. EVERY picker is opened with `pick`, never with a bare `tap`: on 2026-11-15 a
    // slow-loading location picker took more than the tap helper's 700 ms check, the helper
    // re-tapped three times, and the open/close toggling left the next step on a closed form.
    const transfer = JOURNEYS.find((j) => j.id === 'transfer');
    const picks = transfer.steps.filter((step) => step.pick);
    const productPicks = picks.filter((step) => step.pick.sheet === 'Product');
    assert.equal(productPicks.length, 4, 'both transfers and both refusal forms choose the product');
    for (const step of productPicks) {
      assert.equal(step.pick.option, '{{productName}}');
      // Never a search term: with the keyboard up a searchable sheet's rows are clipped out of view
      // (measured 2026-10-26), so a journey that types into it cannot pick anything.
      assert.equal('search' in step.pick, false);
    }

    const locationPicks = picks.filter((step) => step.pick.sheet !== 'Product');
    assert.equal(locationPicks.length, 10, 'stock in/out and both transfers and refusals use location pickers');
    for (const step of locationPicks) {
      assert.match(step.pick.field, /^Choose (a location|the source|the destination)…$/);
      assert.match(step.pick.sheet, /^(Location|From location|To location)$/);
      assert.match(step.pick.option, /^\{\{(source|destination)\}\}$/);
    }
  });

  it('accepts its own table', () => {
    assert.deepEqual(validateJourneys(JOURNEYS), []);
  });

  it('rejects an unknown verb, an empty journey and a duplicate id', () => {
    const problems = validateJourneys([
      { id: 'a', summary: 'x', steps: [{ tap: 'A' }] },
      { id: 'a', summary: 'y', steps: [] },
      { id: 'b', summary: 'z', steps: [{ expect: '' }] },
      { id: 'c', summary: 'w', steps: [{ teleport: 'nowhere' }] },
    ]);

    assert.ok(problems.some((p) => /duplicate id/.test(p)), problems.join('; '));
    assert.ok(problems.some((p) => /no steps/.test(p)), problems.join('; '));
    assert.ok(problems.some((p) => /expect.*empty/.test(p)), problems.join('; '));
    assert.ok(problems.some((p) => /unknown step/.test(p)), problems.join('; '));
  });

  it('rejects a findProduct without a SKU and a pick without its option', () => {
    // A step that cannot name what it is looking for would search for nothing and then wait, which
    // reads as a timeout on an app that is fine.
    const problems = validateJourneys([
      { id: 'a', summary: 'x', steps: [{ findProduct: {} }] },
      { id: 'b', summary: 'x', steps: [{ findProduct: { sku: '   ' } }] },
      { id: 'c', summary: 'x', steps: [{ findProduct: { id: '6adee029e81b7012' } }] },
      { id: 'd', summary: 'x', steps: [{ pick: { field: 'Choose a product…', sheet: 'Product' } }] },
      { id: 'e', summary: 'x', steps: [{ pick: { field: '', sheet: 'Product', option: 'A' } }] },
      { id: 'f', summary: 'x', steps: [{ pick: { field: 'A', sheet: 'B', option: 'C', retries: 2 } }] },
    ]);

    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      assert.ok(problems.some((p) => p.startsWith(`${id}[0]`)), `${id} was accepted: ${problems.join('; ')}`);
    }
    assert.deepEqual(
      validateJourneys([
        { id: 'ok', summary: 'x', steps: [{ findProduct: { sku: 'SMOKE-1' } }, { pick: { field: 'A', sheet: 'B', option: 'C' } }] },
      ]),
      [],
    );
    // `search` is refused outright: it is the one thing a picker cannot survive on this device.
    assert.ok(
      validateJourneys([{ id: 'g', summary: 'x', steps: [{ pick: { field: 'A', sheet: 'B', option: 'C', search: 'C' } }] }]).some(
        (p) => p.startsWith('g[0]'),
      ),
    );
  });

  it('declares a read-only smoke journey that actually asserts screens', () => {
    const smoke = JOURNEYS.find((j) => j.id === 'smoke');

    assert.ok(smoke, 'smoke journey is missing');
    const expects = smoke.steps.filter((s) => typeof s.expect === 'string');
    assert.ok(expects.length >= 5, 'the smoke journey must assert at least five screens');
    // Read-only means no writes: no typing, no create/receive verbs.
    assert.equal(smoke.steps.some((s) => s.type || s.tapFirst), false);
  });

  it('proves data on the smoke journey, so a refused app cannot pass it', () => {
    // Deleting the data assertions must fail this test: 17 headings were not enough evidence on
    // 2026-10-22, and a version of the journey without them reports a green run over no data.
    const smoke = JOURNEYS.find((j) => j.id === 'smoke');
    const data = smoke.steps.filter((s) => s.expectData);

    assert.ok(data.length >= 2, 'the smoke journey must assert data on at least two list screens');
    for (const step of data) {
      assert.ok(step.expectData.match instanceof RegExp, 'an expectData step needs a RegExp match');
      assert.equal(typeof step.expectData.what, 'string');
    }
    // One of them is the inventory screen's own arithmetic line, which is the shape the runner's
    // preflight also waits for — a deliberate single definition.
    assert.ok(data.some((step) => step.expectData.match === INVENTORY_ROW));
    assert.ok(data.some((step) => step.expectData.match === PRODUCT_ROW));

    // The screens that may be empty are covered by "did it finish loading without an error" —
    // deleting those steps would leave five of the seven screens asserting only their heading.
    const clean = smoke.steps.filter((s) => typeof s.expectClean === 'string');
    assert.ok(clean.length >= 5, 'the smoke journey must check every remaining screen for an error state');
  });

  it('rejects an expectClean step that does not name its screen', () => {
    const problems = validateJourneys([
      { id: 'a', summary: 'x', steps: [{ expectClean: '' }] },
      { id: 'b', summary: 'x', steps: [{ expectClean: true }] },
    ]);

    assert.equal(problems.filter((p) => /expectClean/.test(p)).length, 2, problems.join('; '));
  });

  it('rejects malformed expectData steps', () => {
    const problems = validateJourneys([
      { id: 'a', summary: 'x', steps: [{ expectData: {} }] },
      { id: 'b', summary: 'x', steps: [{ expectData: { match: 'SKU', what: 'rows' } }] },
      { id: 'c', summary: 'x', steps: [{ expectData: { match: /SKU/, what: '' } }] },
      { id: 'd', summary: 'x', steps: [{ expectData: { match: /SKU/, what: 'rows', min: 0 } }] },
      { id: 'e', summary: 'x', steps: [{ expectData: { match: /SKU/, what: 'rows', rowsel: 1 } }] },
    ]);

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      assert.ok(problems.some((p) => p.startsWith(`${id}[0]`)), `${id} was accepted: ${problems.join('; ')}`);
    }
    assert.deepEqual(validateJourneys([{ id: 'ok', summary: 'x', steps: [{ expectData: { match: /SKU/, what: 'rows' } }] }]), []);
  });
});

/**
 * The one part of the harness that is I/O rather than judgement: how a file leaves the phone.
 *
 * This is a source guard because the failure it prevents is invisible to a phone-less test — it is
 * a property of an `adb` invocation. The first device run of the `label` journey reported a
 * perfectly good label as "contains no decodable EAN-13": `adb shell cat` had run the PDF through
 * the shell's pseudo-terminal and rewritten every LF as CRLF, so 11,225 bytes arrived as 11,472 and
 * the extra bytes landed inside a Flate-compressed stream. `exec-out` is a raw pipe. A guard that
 * cannot fail is decoration, so the extraction is checked against a control that must trip it.
 */
describe('a binary file leaves the phone unaltered', () => {
  const source = readFileSync(new URL('../../scripts/device/adb.mjs', import.meta.url), 'utf8');

  /** The body of one exported function, so an assertion cannot be satisfied by a different one. */
  const bodyOf = (text, name) => {
    const start = text.indexOf(`export function ${name}(`);
    if (start < 0) return null;
    const next = text.indexOf('\nexport ', start + 1);
    return text.slice(start, next < 0 ? undefined : next);
  };

  const reading = (text) => {
    const body = bodyOf(text, 'readAppPdf');
    return body !== null && /'exec-out'/.test(body) && !/'shell'/.test(body);
  };

  it('reads the app PDF with exec-out, not through the device shell', () => {
    const body = bodyOf(source, 'readAppPdf');
    assert.ok(body, 'readAppPdf is missing from adb.mjs');
    assert.match(body, /'exec-out'/);
    assert.doesNotMatch(body, /'shell'/);
  });

  it('the same check rejects a shell-based read (control)', () => {
    assert.equal(reading(source), true);
    assert.equal(
      reading("export function readAppPdf(name) { return ['shell', 'run-as', 'cat'] }\n"),
      false,
    );
  });
});

#!/usr/bin/env node
/**
 * Drive a real Android phone through the app's journeys and leave evidence behind.
 *
 * WHY THIS EXISTS. Every device pass so far has been a hand-written sequence of `adb input tap`
 * coordinates, and the coordinates only work on the screen they were measured on. The result was a
 * session that proved a lot and recorded it as screenshots in a chat, with no way to re-run it.
 * This runs the same journeys as data, asserts each screen from the accessibility tree instead of
 * from a pixel position, writes a report and screenshots into `docs/evidence/device-runs/`, and
 * exits 0 / 1 / 2 the way the rest of this repository does: passed, failed, or could not check.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. It proves the app renders the screens it should, that the
 * routes work, that the print path writes a PDF whose barcode decodes, and (with `draft`) that a
 * purchase-order form submits. It does NOT prove a screen looks right, that a camera read a real
 * barcode, or that a printer printed — a human still looks at the screenshots, and the camera half
 * stays a manual item.
 *
 * USAGE (phone connected, app installed, tunnels up — see docs/DEVELOPING_ON_A_PHYSICAL_DEVICE.md):
 *
 *   node scripts/device/run.mjs --list
 *   node scripts/device/run.mjs                      # the read-only smoke journey
 *   node scripts/device/run.mjs --journey=label --sku=SMOKE-1
 *   node scripts/device/run.mjs --journey=stock --sku=SMOKE-1 --source='Smoke shelf' --allow-writes
 *   node scripts/device/run.mjs --journey=draft --allow-writes
 *   node scripts/device/run.mjs --all                # smoke + label (writes excluded)
 *   node scripts/device/run.mjs --self-test          # the harness's own controls, no phone needed
 *
 * NO JOURNEY TAKES AN INTERNAL ID. A product is found by its SKU through the products search (the
 * way a person finds one) and the app's own screen confirms which product is open before a step
 * acts on it; the transfer form's product is chosen from its picker by the name that screen proved.
 *
 * Exit codes: 0 every step passed, 1 a step failed, 2 could not check (no device, no signed-in
 * session, no debuggable build, no artifact) — never reported as a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as device from './adb.mjs';
import { DeviceUnavailable } from './adb.mjs';
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
  judgeDataRows,
  judgeSettled,
  looksAtDevLauncher,
  looksLikePicker,
  looksSessionExpired,
  looksSignedOut,
  optionTarget,
  parseMovements,
  rowsMatching,
  summariseRun,
  unfilledPlaceholders,
  validateJourneys,
} from './lib.mjs';
import { INVENTORY_ROW, JOURNEYS, WRITE_JOURNEYS } from './journeys.mjs';

// Imported, not re-implemented: the device journey and the CI check must read the same bars the
// same way, or "it decodes on the phone" would mean something different from "it decodes in CI".
import { decodeEan13Bits, decodeEan13FromPdf } from '../verify-label-barcode.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DEFAULT_EVIDENCE = join(ROOT, 'docs', 'evidence', 'device-runs');

/**
 * Labels that are sheet chrome rather than a row a journey wants to tap.
 *
 * `No options available.` belongs here: a picker whose list is empty prints it where the rows would
 * be, and tapping it selects nothing — the journey then failed a step later, on a form with an empty
 * field, which reads like a broken form. As chrome, `tapFirst` reports "the sheet had no rows" and
 * names the real precondition (a tenant with no supplier yet).
 */
const CHROME = new Set(['Done', 'Dismiss', 'Search…', 'Search...', 'Cancel', 'Close', '×', 'No options available.']);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const args = {
    journeys: [],
    allowWrites: false,
    verifyLedger: false,
    verifyProduction: false,
    all: false,
    timeoutMs: 15_000,
  };
  for (const raw of argv) {
    const [flag, ...rest] = raw.replace(/^--/, '').split('=');
    const value = rest.join('=');
    switch (flag) {
      case 'journey':
        args.journeys.push(value);
        break;
      case 'all':
        args.all = true;
        break;
      case 'list':
        args.list = true;
        break;
      case 'self-test':
        args.selfTest = true;
        break;
      case 'allow-writes':
        args.allowWrites = true;
        break;
      case 'verify-ledger':
        args.verifyLedger = true;
        break;
      case 'verify-production':
        args.verifyProduction = true;
        break;
      case 'business':
        args.businessId = value;
        break;
      case 'sku':
        args.sku = value;
        break;
      case 'source':
        args.source = value;
        break;
      case 'destination':
        args.destination = value;
        break;
      case 'supplier':
        args.supplier = value;
        break;
      case 'location':
        args.location = value;
        break;
      case 'product1':
        args.product1 = value;
        break;
      case 'product2':
        args.product2 = value;
        break;
      case 'proxy-log':
        args.proxyLog = value;
        break;
      case 'dev-server-url':
        args.devServerUrl = value;
        break;
      case 'database':
        args.database = value;
        break;
      case 'out':
        args.out = value;
        break;
      case 'serial':
        args.serial = value;
        break;
      case 'adb':
        args.adbPath = value;
        break;
      case 'timeout':
        args.timeoutMs = Number(value);
        break;
      case 'until':
        args.until = Number(value);
        break;
      default:
        args.unknown = [...(args.unknown ?? []), raw];
    }
  }
  return args;
}

function chosenJourneys(args) {
  if (args.journeys.length) return JOURNEYS.filter((j) => args.journeys.includes(j.id));
  if (args.all) return JOURNEYS.filter((j) => !WRITE_JOURNEYS.includes(j.id));
  return JOURNEYS.filter((j) => j.id === 'smoke');
}

/**
 * A step's title, for the report. Derived from the verb so it never drifts from the table.
 *
 * Placeholders are FILLED, because the report is the artifact people read later: a kept run whose
 * step reads `open inventoryai://stock-in?productId={{product}}&lock=1` does not say which product
 * was moved. Measured on the 17/17 `stock` run of 2026-10-22, whose titles carried the raw markers.
 */
function titleOf(step, ctx) {
  const [[verb, raw]] = Object.entries(step);
  const value = typeof raw === 'string' && ctx ? fillTemplate(raw, templateVars(ctx)) : raw;
  if (verb === 'open') return `open ${value}`;
  if (verb === 'expect') return `expect "${value}"`;
  if (verb === 'expectGone') return `expect "${value}" to be gone`;
  if (verb === 'expectDisabled') return `expect "${value}" to be disabled`;
  if (verb === 'tap') return `tap "${value}"`;
  if (verb === 'tapFirst') return `tap the first row under "${value}"`;
  if (verb === 'type') return 'type into the focused field';
  if (verb === 'key') return `press ${value}`;
  if (verb === 'scroll') return `scroll ${value}`;
  if (verb === 'wait') return `wait ${value}ms`;
  if (verb === 'shot') return `screenshot "${value}"`;
  if (verb === 'readCode') return 'read the barcode off the screen';
  if (verb === 'decodeLabel') return 'decode the printed PDF';
  if (verb === 'movement') return `check the movement arithmetic (${value?.deltas?.join(', ')})`;
  if (verb === 'expectStopped') return `force-stopped ${value?.package} after its Draft PO request`;
  if (verb === 'relaunch') return `cold relaunch and open ${value}`;
  if (verb === 'verifyDraftResume') return 'verify exactly one DRAFT for the captured key/body';
  if (verb === 'expectData') return `expect ${value?.what ?? 'rows'} on screen`;
  if (verb === 'expectClean') return `expect ${value} to load without an error`;
  if (verb === 'findProduct') {
    const sku = ctx ? fillTemplate(value?.sku ?? '', templateVars(ctx)) : (value?.sku ?? '');
    return `find the product with SKU ${sku} through the products search`;
  }
  if (verb === 'verifyTransfer') {
    return 'verify the six movements and final stock against MongoDB';
  }
  if (verb === 'pick') {
    const option = ctx ? fillTemplate(value?.option ?? '', templateVars(ctx)) : (value?.option ?? '');
    return `choose "${option}" from the "${value?.sheet}" picker`;
  }
  return verb;
}

/** A short, honest description of what is on screen, for a failure message. */
function visibleLabels(screen, limit = 10) {
  return screen.nodes
    .slice(0, limit)
    .map((node) => node.label)
    .join(' | ');
}

/** The run's flags, as template values. */
function templateVars(ctx) {
  return {
    // `productName` is read off the phone by `findProduct`, not supplied: the transfer form's
    // product picker filters on the NAME, so the name is the handle a picker needs.
    sku: ctx.sku,
    productName: ctx.productName,
    source: ctx.source,
    destination: ctx.destination,
    supplier: ctx.supplier,
    location: ctx.location,
    product1: ctx.product1,
    product2: ctx.product2,
    proxyLog: ctx.proxyLog,
    database: ctx.database,
    runId: ctx.runId,
  };
}

/**
 * Fill a step's placeholders, or say which flag is missing.
 *
 * A missing flag is BLOCKED rather than failed: the app was never asked the question, so calling it
 * wrong would be the harness inventing a defect.
 */
function resolveStepText(value, ctx) {
  const filled = fillTemplate(String(value), templateVars(ctx));
  const missing = unfilledPlaceholders(filled);
  if (missing.length) {
    return { missing: `needs ${missing.map((name) => `--${name}=…`).join(' and ')}` };
  }
  return { text: filled };
}

async function runStep(step, ctx) {
  const [[verb, value]] = Object.entries(step);
  const adbArgs = { adbPath: ctx.adbPath, serial: ctx.serial };

  switch (verb) {
    case 'open': {
      const filled = resolveStepText(value, ctx);
      if (filled.missing) return { status: 'blocked', detail: `open ${value} ${filled.missing}` };
      const route = filled.text;
      device.openRoute(route, adbArgs);
      await sleep(900);
      return { status: 'pass', detail: route };
    }

    case 'expect':
    case 'expectGone': {
      const resolved = resolveStepText(value, ctx);
      if (resolved.missing) return { status: 'blocked', detail: `${verb} ${value} ${resolved.missing}` };
      const want = resolved.text;
      const deadline = Date.now() + ctx.timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          const screen = await device.readScreen(adbArgs);
          last = screen;
          const present = findNodes(screen.nodes, want).length > 0;
          if (verb === 'expect' ? present : !present) {
            return { status: 'pass', detail: `seen after ${ctx.timeoutMs - (deadline - Date.now())}ms` };
          }
        } catch {
          // An unreadable screen is not evidence either way; keep trying until the deadline.
        }
        await sleep(500);
      }
      return {
        status: 'fail',
        detail: `expected "${want}" within ${ctx.timeoutMs}ms; screen showed: ${
          last ? visibleLabels(last) : 'nothing readable'
        }`,
      };
    }

    case 'expectDisabled': {
      const resolved = resolveStepText(value, ctx);
      if (resolved.missing) return { status: 'blocked', detail: `expectDisabled ${value} ${resolved.missing}` };
      const wanted = resolved.text;
      const deadline = Date.now() + ctx.timeoutMs;
      let last = null;

      while (Date.now() < deadline) {
        try {
          const screen = await device.readScreen(adbArgs);
          last = screen;
          if (disabledTarget(screen.nodes, wanted)) {
            return { status: 'pass', detail: `"${wanted}" is disabled` };
          }
        } catch {
          // An unreadable screen is not evidence either way; keep trying.
        }
        await sleep(500);
      }

      return {
        status: 'fail',
        detail: `"${wanted}" was not observed disabled within ${ctx.timeoutMs}ms; screen showed: ${
          last ? visibleLabels(last) : 'nothing readable'
        }`,
      };
    }

    case 'tap': {
      // A control below the fold is not a missing control. The first `draft` run failed on
      // "Create draft order" only because the keyboard had pushed it off the screen, so a tap
      // scrolls down and looks again before it calls the control absent. Bounded, and said out
      // loud in the report, so a genuinely missing control still fails.
      const resolved = resolveStepText(value, ctx);
      if (resolved.missing) return { status: 'blocked', detail: `tap ${value} ${resolved.missing}` };
      const wanted = resolved.text;
      let screen = await device.readScreen(adbArgs);
      let target = findTapTarget(screen.nodes, wanted);
      let scrolled = 0;
      while (!target && scrolled < 2) {
        device.swipe(540, 1500, 540, 700, adbArgs);
        await sleep(700);
        screen = await device.readScreen(adbArgs);
        target = findTapTarget(screen.nodes, wanted);
        scrolled += 1;
      }
      if (!target) {
        return { status: 'fail', detail: `no control labelled "${wanted}"; screen showed: ${visibleLabels(screen)}` };
      }
      device.tap(target.center.x, target.center.y, adbArgs);
      await sleep(700);

      // A picker whose options are still loading is DISABLED, so a tap on it does nothing and the
      // next step fails with "no such row" — which reads like a missing option. Tapping again is
      // safe (opening a picker twice submits nothing), so repeat until its sheet appears.
      let retries = 0;
      if (looksLikePicker(wanted)) {
        while (retries < 3) {
          const after = await device.readScreen(adbArgs);
          if (findNodes(after.nodes, 'Done', { exact: true }).length) break;
          retries += 1;
          device.tap(target.center.x, target.center.y, adbArgs);
          await sleep(900);
        }
      }

      return {
        status: 'pass',
        detail:
          `tapped ${target.label} at ${target.center.x},${target.center.y}` +
          `${scrolled ? ` after ${scrolled} scroll` : ''}` +
          `${retries ? ` (re-tapped ${retries}× while the picker loaded)` : ''}`,
      };
    }

    case 'tapFirst': {
      const resolved = resolveStepText(value, ctx);
      if (resolved.missing) return { status: 'blocked', detail: `tapFirst ${value} ${resolved.missing}` };
      const heading = resolved.text;
      const screen = await device.readScreen(adbArgs);

      // A SHEET MUST ACTUALLY BE OPEN. The same words also label the form field the sheet belongs
      // to (`Supplier *`), so without this a disabled picker — one whose list is empty, which
      // happens on a tenant with nothing to choose — looked like a sheet and this tapped a form row.
      if (!hasSheetClose(screen.nodes)) {
        // BLOCKED, not failed: a picker renders disabled when it has nothing to list, so a tenant
        // with no suppliers (or no locations) cannot open it — a precondition. The message names
        // both possibilities rather than deciding which one it is.
        return {
          status: 'blocked',
          detail:
            `no sheet opened for "${heading}" — a picker with an empty list is disabled, so this ` +
            `tenant may have nothing to choose here; nothing was judged. Screen showed: ${visibleLabels(screen)}`,
        };
      }

      const anchor = findTapTarget(screen.nodes, heading, { exact: true }) ?? findTapTarget(screen.nodes, heading);
      if (!anchor) {
        return { status: 'fail', detail: `no sheet heading "${heading}"; screen showed: ${visibleLabels(screen)}` };
      }
      const rows = screen.nodes
        .filter((node) => node.bounds.y1 > anchor.bounds.y2 && !CHROME.has(node.label))
        .filter((node) => node.label.length > 2)
        .sort((a, b) => a.bounds.y1 - b.bounds.y1);
      const row = rows[0];
      if (!row) {
        return { status: 'fail', detail: `the "${heading}" sheet had no rows; screen showed: ${visibleLabels(screen)}` };
      }
      device.tap(row.center.x, row.center.y, adbArgs);
      await sleep(800);

      // And the sheet must CLOSE: a tap that selected nothing leaves it open, and the next step then
      // fails on a form the sheet is covering — the wrong control, one step late.
      const after = await device.readScreen(adbArgs);
      if (hasSheetClose(after.nodes)) {
        return {
          status: 'fail',
          detail: `tapped "${row.label}" but the "${heading}" sheet stayed open — nothing was chosen`,
        };
      }
      return { status: 'pass', detail: `tapped "${row.label}"` };
    }

    case 'type': {
      // Copied: both the value and `into` are resolved below, and the journey table
      // is shared data, not run state. Resolving only `into` let
      // `PHONE-TRF-{{runId}}-IN` reach the form as literal text (measured on the
      // first transfer run, 2026-11-15), so the verifier could not find its rows.
      const spec = typeof value === 'string' ? { value } : { ...value };
      const valueResolved = resolveStepText(spec.value, ctx);
      if (valueResolved.missing) {
        return { status: 'blocked', detail: `type value ${spec.value} ${valueResolved.missing}` };
      }
      spec.value = valueResolved.text;
      let field = null;
      if (spec.into) {
        const resolved = resolveStepText(spec.into, ctx);
        if (resolved.missing) return { status: 'blocked', detail: `type into ${spec.into} ${resolved.missing}` };
        spec.into = resolved.text;
      }

      if (spec.into) {
        // The label is looked for until the screen settles, then after one scroll: closing a
        // picker re-renders the form from the top, so a single immediate dump reads a screen that
        // is about to be replaced (measured: "no input field below Quantity ordered" on a form
        // that has one).
        const deadline = Date.now() + ctx.timeoutMs;
        let screen = await device.readScreen(adbArgs);
        field = fieldBelow(screen.nodes, spec.into);
        while (!field && Date.now() < deadline) {
          await sleep(500);
          screen = await device.readScreen(adbArgs);
          field = fieldBelow(screen.nodes, spec.into);
        }
        if (!field) {
          device.swipe(540, 1500, 540, 700, adbArgs);
          await sleep(800);
          screen = await device.readScreen(adbArgs);
          field = fieldBelow(screen.nodes, spec.into);
        }
        if (!field) {
          // An empty text input sometimes reaches the dump with no label at all, so there is no
          // node to point at even though the field is on screen. Fall back to the geometry every
          // form in this app uses — the input sits just under its label — and let the read-back
          // below decide whether the tap landed. A wrong guess still fails, one step later and
          // with the value's absence quoted.
          const anchor = findNodes(screen.nodes, spec.into)[0];
          if (!anchor) {
            return {
              status: 'fail',
              detail: `no control labelled "${spec.into}"; screen showed: ${visibleLabels(screen)}`,
            };
          }
          field = { center: { x: Math.round((anchor.bounds.x1 + anchor.bounds.x2) / 2), y: anchor.bounds.y2 + 60 } };
        }
        device.tap(field.center.x, field.center.y, adbArgs);
        await sleep(600);
      }

      device.typeText(escapeInputText(spec.value), adbArgs);
      await sleep(600);

      // Read the field back. "It typed" is not the same claim as "the value is in the field", and
      // the difference is exactly what made the first draft run fail three steps later.
      if (field) {
        const after = await device.readScreen(adbArgs);
        const landed = after.nodes.some((node) => node.label.includes(String(spec.value)));
        if (!landed) {
          return {
            status: 'fail',
            detail: `typed "${spec.value}" into "${spec.into}" but the screen does not show it: ${visibleLabels(after)}`,
          };
        }
        // Leave the screen as a person would: the keyboard covers the form's buttons, and a
        // swipe meant to scroll would land on the keys instead. BACK is pressed only when the IME
        // says it is open, and the label is re-read afterwards so a navigation would be caught.
        let closed = '';
        if (device.keyboardShown(adbArgs)) {
          device.pressKey('BACK', adbArgs);
          await sleep(800);
          const settled = await device.readScreen(adbArgs);
          if (!findNodes(settled.nodes, spec.into).length) {
            return {
              status: 'fail',
              detail: `closing the keyboard left the screen; "${spec.into}" is gone: ${visibleLabels(settled)}`,
            };
          }
          closed = ', keyboard closed';
        }

        return { status: 'pass', detail: `"${spec.into}" now reads ${spec.value}${closed}` };
      }

      return { status: 'pass', detail: 'typed into the focused field' };
    }

    case 'key': {
      device.pressKey(String(value), adbArgs);
      await sleep(600);
      return { status: 'pass', detail: `pressed ${value}` };
    }

    case 'scroll': {
      const direction = value === 'up' ? 1 : -1;
      device.swipe(540, direction > 0 ? 700 : 1500, 540, direction > 0 ? 1500 : 700, adbArgs);
      await sleep(600);
      return { status: 'pass', detail: `scrolled ${value}` };
    }

    case 'wait': {
      await sleep(Number(value));
      return { status: 'pass', detail: `${value}ms` };
    }

    case 'shot': {
      const file = join(ctx.outDir, `${String(value).replace(/[^\w.-]+/g, '-')}.png`);
      device.screenshot(file, adbArgs);
      return { status: 'pass', detail: file };
    }

    case 'readCode': {
      const screen = await device.readScreen(adbArgs);
      const code = screen.nodes.map((node) => node.label).find((label) => /^\d{13}$/.test(label));
      if (!code) {
        return {
          status: 'blocked',
          detail: `no 13-digit barcode on this screen; screen showed: ${visibleLabels(screen)}`,
        };
      }
      if (decodeEan13Bits(moduleBitsFor(code)) === null) {
        return { status: 'blocked', detail: `${code} is not a valid EAN-13 (check digit)` };
      }
      ctx.expectedCode = code;
      return { status: 'pass', detail: `screen shows ${code}` };
    }

    case 'decodeLabel': {
      if (!ctx.expectedCode) {
        return { status: 'fail', detail: 'no code was read off the screen first (readCode)' };
      }
      const deadline = Date.now() + Math.max(ctx.timeoutMs, 20_000);
      let names = [];
      try {
        while (Date.now() < deadline) {
          names = device.appPdfs(adbArgs);
          const fresh = names.filter((name) => !ctx.pdfBaseline.includes(name));
          if (fresh.length) break;
          await sleep(800);
        }
      } catch (err) {
        if (err instanceof DeviceUnavailable) return { status: 'blocked', detail: err.message };
        throw err;
      }

      const fresh = names.filter((name) => !ctx.pdfBaseline.includes(name));
      if (!fresh.length) {
        return { status: 'fail', detail: 'the print action wrote no new PDF into the app cache' };
      }

      const pdf = device.readAppPdf(fresh[0], adbArgs);
      const decoded = decodeEan13FromPdf(pdf);
      if (!decoded) {
        return { status: 'fail', detail: `${fresh[0]} contains no decodable EAN-13 (clipped or damaged)` };
      }
      if (decoded.code !== ctx.expectedCode) {
        return {
          status: 'fail',
          detail: `${fresh[0]} decodes to ${decoded.code}, but the screen shows ${ctx.expectedCode}`,
        };
      }
      ctx.pdfBaseline = names;
      return {
        status: 'pass',
        detail: `${fresh[0]}: ${decoded.code}, ${decoded.modules} modules, ${decoded.bars} bars, ${decoded.unit}pt module`,
      };
    }

    case 'movement': {
      // The app's own confirmation, read back: `from → to` with the difference it claims. A journey
      // that typed "5" and saw "Done." proves only that a dialog appeared; this proves the number
      // moved by 5 — and does it without hard-coding a starting quantity, so the second run of the
      // same journey still means something.
      const expected = value.deltas;
      const deadline = Date.now() + Math.max(ctx.timeoutMs, 20_000);
      let parsed = [];
      let last = null;

      while (Date.now() < deadline) {
        try {
          const screen = await device.readScreen(adbArgs);
          last = screen;
          parsed = parseMovements(screen.nodes.map((node) => node.label).join('\n'));
          if (parsed.length >= expected.length) break;
        } catch {
          // An unreadable screen is not evidence either way; keep trying.
        }
        await sleep(500);
      }

      if (parsed.length !== expected.length) {
        return {
          status: 'fail',
          detail: `expected ${expected.length} movement(s), saw ${parsed.length}; screen showed: ${
            last ? visibleLabels(last) : 'nothing readable'
          }`,
        };
      }

      const actual = parsed.map((move) => move.diff);
      if (actual.join(',') !== expected.join(',')) {
        return {
          status: 'fail',
          detail: `the app says ${parsed.map((move) => `${move.from} → ${move.to}`).join(', but ')} — expected deltas of ${expected.join(', ')}`,
        };
      }

      return {
        status: 'pass',
        detail: parsed.map((move) => `${move.from} → ${move.to}`).join(', ') + ` (${actual.join(', ')})`,
      };
    }

    case 'expectClean': {
      // The screens that may be empty. Loading is not an answer, and an error is a defect: this
      // exists because a heading renders over a failed request just as well as over a good one.
      const screenName = String(value);
      const began = Date.now();
      const deadline = began + Math.max(ctx.timeoutMs, 12_000);

      for (;;) {
        let judgement = null;
        try {
          judgement = judgeSettled((await device.readScreen(adbArgs)).nodes);
        } catch {
          // An unreadable screen is not evidence either way; keep trying until the deadline.
        }

        if (judgement?.verdict === 'clean') return { status: 'pass', detail: judgement.detail };
        if (judgement?.verdict === 'error') {
          return { status: 'fail', detail: `${screenName} did not load: ${judgement.detail}` };
        }
        if (Date.now() >= deadline) {
          // Out of time rather than observed wrong: the run says it could not check.
          return {
            status: 'blocked',
            detail: `${screenName} was still loading after ${Math.round((Date.now() - began) / 1000)}s — nothing was judged`,
          };
        }
        await sleep(700);
      }
    }

    case 'expectData': {
      // The assertion headings cannot make: wait for a label only the SERVER's data can produce.
      // A screen whose requests were all refused still renders its heading, its search box and its
      // chips — it just lands in the error state below them, which is what this fails on.
      const what = String(value?.what ?? 'rows');
      const deadline = Date.now() + Math.max(ctx.timeoutMs, 15_000);
      let last = null;

      for (;;) {
        let judgement = null;
        try {
          const screen = await device.readScreen(adbArgs);
          last = screen;
          judgement = judgeDataRows(screen.nodes, value);
        } catch {
          // An unreadable screen is not evidence either way; keep trying until the deadline.
        }

        if (judgement?.verdict === 'rows') return { status: 'pass', detail: judgement.detail };
        // A refusal is worth failing on at once — waiting cannot turn a `401` into rows, and the
        // report names the state that was actually seen.
        if (judgement?.verdict === 'error') {
          return { status: 'fail', detail: `expected ${what}, but ${judgement.detail}` };
        }
        if (Date.now() >= deadline) {
          if (!judgement) return { status: 'blocked', detail: `could not read the screen to check ${what}` };
          // An empty tenant is a precondition, not a defect: nothing was proven either way.
          if (judgement.verdict === 'empty') {
            return {
              status: 'blocked',
              detail: `no ${what} to prove — ${judgement.detail}; this tenant has none, so data was never checked`,
            };
          }
          return {
            status: 'fail',
            detail: `expected ${what}, but ${judgement.detail}; screen showed: ${
              last ? visibleLabels(last) : 'nothing readable'
            }`,
          };
        }
        await sleep(700);
      }
    }

    case 'findProduct': {
      // OPEN A PRODUCT BY SKU, THROUGH THE APP'S OWN SEARCH.
      //
      // The specialised journeys used to need `--product=<id>`, and an id is not a fact anybody can
      // read off a phone: the app shows none, so the only way to have one was to have written it
      // down at seed time. A run that depends on that is not a run a person can repeat, and a stale
      // id makes a deep link load a product that no longer exists — which looks like an app defect.
      //
      // A user finds a product by typing its SKU into the products search. This does the same, then
      // PROVES the destination from the detail screen's own SKU value before any later step acts on
      // it. Nothing about the id is guessed, recorded or hard-coded.
      const skuText = resolveStepText(value?.sku, ctx);
      if (skuText.missing) return { status: 'blocked', detail: `findProduct ${value?.sku} ${skuText.missing}` };
      const sku = skuText.text;
      ctx.sku = sku;
      const began = Date.now();

      device.openRoute('inventoryai://products', adbArgs);
      await sleep(1200);

      const SEARCH = 'Search by name, SKU or barcode…';
      // 30s, not the step timeout: a deep link into a cold-started build lands on the app's
      // "Restoring session…" screen first, and the products list does not exist until that
      // finishes. Measured 2026-10-26 — a 15s budget called it "no search box" while the app was
      // still booting, which reads like a missing control.
      const searchDeadline = Date.now() + Math.max(ctx.timeoutMs, 30_000);
      let screen = null;
      let field = null;
      while (Date.now() < searchDeadline && !field) {
        try {
          screen = await device.readScreen(adbArgs);
        } catch {
          await sleep(500);
          continue;
        }
        field =
          screen.nodes.find((node) => node.label === SEARCH && !node.brokenBounds) ??
          // A previous journey (or a person) may have left text in it, which makes the typed text
          // its label; the search box is still the first editable field on the screen.
          screen.nodes.find(
            (node) => !node.brokenBounds && node.clickable && /EditText$/.test(node.className ?? ''),
          ) ??
          null;
        if (!field) await sleep(500);
      }
      if (!field) {
        return {
          status: 'fail',
          detail: `the Products screen has no search box; screen showed: ${
            screen ? visibleLabels(screen) : 'nothing readable'
          }`,
        };
      }

      // Leftover text would be APPENDED to, so clear what is there before typing.
      const leftover = field.label === SEARCH ? '' : field.label;
      device.tap(field.center.x, field.center.y, adbArgs);
      await sleep(500);
      if (leftover) {
        device.pressKey('123', adbArgs); // KEYCODE_MOVE_END
        for (let i = 0; i < leftover.length; i += 1) device.pressKey('DEL', adbArgs);
        await sleep(300);
      }
      device.typeText(escapeInputText(sku), adbArgs);
      await sleep(1200);

      // The keyboard covers the lower half of the list; close it only when it is actually up, or
      // BACK would leave the screen instead (the trap the device guide records).
      if (device.keyboardShown(adbArgs)) {
        device.pressKey('BACK', adbArgs);
        await sleep(800);
      }

      let row = null;
      const listDeadline = Date.now() + Math.max(ctx.timeoutMs, 12_000);
      while (Date.now() < listDeadline) {
        try {
          screen = await device.readScreen(adbArgs);
          row = findProductRow(screen.nodes, sku);
        } catch {
          row = null;
        }
        if (row) break;
        await sleep(600);
      }
      if (!row) {
        // No such product in this tenant is a PRECONDITION, not an app defect.
        return {
          status: 'blocked',
          detail: `no product row for SKU ${sku} (the list is ${
            screen ? describeListState(screen.nodes).state : 'unreadable'
          }); screen showed: ${screen ? visibleLabels(screen) : 'nothing readable'}`,
        };
      }

      device.tap(row.meta.center.x, row.meta.center.y, adbArgs);
      await sleep(1200);

      // The proof: the detail screen prints the SKU as its own value, so an exact node is the app
      // confirming which product is open.
      let detail = null;
      const detailDeadline = Date.now() + Math.max(ctx.timeoutMs, 12_000);
      while (Date.now() < detailDeadline) {
        try {
          const read = await device.readScreen(adbArgs);
          if (read.nodes.some((node) => node.label === sku)) {
            detail = read;
            break;
          }
        } catch {
          // An unreadable screen is not evidence either way; keep trying.
        }
        await sleep(500);
      }
      if (!detail) {
        return {
          status: 'fail',
          detail: `tapped the row for SKU ${sku} but the product screen does not show that SKU; screen showed: ${
            screen ? visibleLabels(screen) : 'nothing readable'
          }`,
        };
      }

      // Only a name this screen also prints is kept: `pick` must never search for a guess.
      ctx.productName = row.name && detail.nodes.some((node) => node.label === row.name) ? row.name : null;
      return {
        status: 'pass',
        detail: `opened ${ctx.productName ?? '(name not readable)'} (SKU ${sku}) through the products search in ${
          Date.now() - began
        }ms`,
      };
    }

    case 'pick': {
      // Choose one option from a picker by its VISIBLE label, scrolling the list to find it.
      //
      // The transfer form's product picker lists names, so a journey that knows only a SKU cannot
      // use it — which is why this takes the name `findProduct` read off the phone. `optionTarget`
      // refuses an ambiguous choice rather than tapping the first hit: on this form the wrong row
      // moves the wrong product's stock, and no later assertion can undo that.
      //
      // IT NEVER TYPES INTO THE SHEET'S SEARCH BOX. Measured on the phone 2026-10-26: with the IME
      // up, a searchable picker's list is squeezed to nothing and its rows are clipped out of view —
      // the row was in the hierarchy at y 1422–1575 and painted nowhere (screenshot), while the same
      // sheet with the keyboard down shows it at 2055–2208. BACK and ESCAPE close the whole sheet
      // (the Modal's request-close), so there is no way to dismiss the IME and keep the results.
      // Scrolling the list needs no keyboard, so the choice is one a person can actually make.
      const spec = value ?? {};
      const want = {};
      for (const key of ['field', 'sheet', 'option']) {
        if (spec[key] === undefined) continue;
        const resolved = resolveStepText(spec[key], ctx);
        if (resolved.missing) return { status: 'blocked', detail: `pick ${key} ${spec[key]} ${resolved.missing}` };
        want[key] = resolved.text;
      }

      let screen = await device.readScreen(adbArgs);
      let trigger = findTapTarget(screen.nodes, want.field);
      let scrolled = 0;
      while (!trigger && scrolled < 2) {
        device.swipe(540, 1500, 540, 700, adbArgs);
        await sleep(700);
        screen = await device.readScreen(adbArgs);
        trigger = findTapTarget(screen.nodes, want.field);
        scrolled += 1;
      }
      if (!trigger) {
        return { status: 'fail', detail: `no field labelled "${want.field}"; screen showed: ${visibleLabels(screen)}` };
      }

      device.tap(trigger.center.x, trigger.center.y, adbArgs);
      await sleep(800);

      let heading = null;
      const sheetDeadline = Date.now() + Math.max(ctx.timeoutMs, 8_000);
      while (Date.now() < sheetDeadline && !heading) {
        try {
          screen = await device.readScreen(adbArgs);
          heading = findNodes(screen.nodes, want.sheet, { exact: true })[0] ?? null;
        } catch {
          heading = null;
        }
        if (!heading) await sleep(400);
      }
      if (!heading) {
        return {
          status: 'fail',
          detail: `the "${want.field}" sheet did not open ("${want.sheet}" is not on screen); screen showed: ${
            screen ? visibleLabels(screen) : 'nothing readable'
          }`,
        };
      }

      // ONE dump for both the exclusion and the choice: node objects are rebuilt on every read, so
      // a heading taken from an earlier screen would exclude nothing.
      screen = await device.readScreen(adbArgs);
      let headingNow = findNodes(screen.nodes, want.sheet, { exact: true })[0] ?? null;
      let option = optionTarget(screen.nodes, want.option, { exclude: headingNow });

      // Not on screen yet: scroll the sheet's list, which is how a person reaches a row in a picker
      // with more products than fit. Bounded, and every attempt re-reads, so the sheet is never
      // scrolled past the answer and tapped blind.
      let listScrolls = 0;
      while (!option && listScrolls < 8) {
        const anchor = headingNow?.center.y ?? 1200;
        device.swipe(540, Math.round(anchor + 400), 540, Math.round(anchor + 150), adbArgs);
        await sleep(700);
        screen = await device.readScreen(adbArgs);
        headingNow = findNodes(screen.nodes, want.sheet, { exact: true })[0] ?? null;
        option = optionTarget(screen.nodes, want.option, { exclude: headingNow });
        listScrolls += 1;
      }

      if (!option) {
        return {
          status: 'fail',
          detail: `no single "${want.option}" in the "${want.sheet}" sheet${
            listScrolls ? ` after ${listScrolls} scroll(s)` : ''
          }; screen showed: ${visibleLabels(screen)}`,
        };
      }

      device.tap(option.center.x, option.center.y, adbArgs);
      await sleep(900);

      // THE SHEET MUST CLOSE. Checking only that the words are on screen was a false pass: the
      // sheet still lists the option, so a tap that selected nothing looked exactly like one that
      // did, and the next step failed on a form the open sheet was covering.
      let closed = null;
      const closeBy = Date.now() + 6_000;
      while (Date.now() < closeBy) {
        try {
          closed = await device.readScreen(adbArgs);
        } catch {
          closed = null;
        }
        if (closed && !findNodes(closed.nodes, want.sheet, { exact: true }).length) break;
        closed = null;
        await sleep(400);
      }
      if (!closed) {
        return {
          status: 'fail',
          detail: `tapped "${want.option}" but the "${want.sheet}" sheet is still open — nothing was chosen`,
        };
      }

      if (!findNodes(closed.nodes, want.option).length) {
        return {
          status: 'fail',
          detail: `the sheet closed but the field does not show "${want.option}"; screen showed: ${visibleLabels(closed)}`,
        };
      }
      return {
        status: 'pass',
        detail: `chose "${want.option}"${listScrolls ? ` after ${listScrolls} scroll(s)` : ''}`,
      };
    }

    case 'expectStopped': {
      const spec = value ?? {};
      const log = resolveStepText(spec.proxyLog, ctx);
      if (log.missing) return { status: 'blocked', detail: `expectStopped ${spec.proxyLog} ${log.missing}` };
      const requestKey = resolveStepText(spec.package, ctx);
      if (requestKey.missing) return { status: 'blocked', detail: `expectStopped ${spec.package} ${requestKey.missing}` };

      const journal = log.text;
      const pkg = requestKey.text;
      const since = Date.parse(ctx.startedAt ?? '');
      if (!Number.isFinite(since)) {
        return { status: 'blocked', detail: 'the run start time is unavailable; cannot rule out a stale proxy entry' };
      }
      const target = ctx.serial ? ['-s', ctx.serial] : [];
      const deadline = Date.now() + Math.max(ctx.timeoutMs, 12_000);
      let request = null;
      let forceStop = null;
      let pid = '';
      let pidCheckError = null;

      while (Date.now() < deadline) {
        if (existsSync(journal)) {
          const events = readFileSync(journal, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const inThisRun = events.filter((event) => {
            const ts = Date.parse(event.ts);
            return Number.isFinite(ts) && ts >= since;
          });
          request =
            inThisRun
              .filter((event) => event.event === 'request' && event.url === '/api/purchase-orders/from-restock')
              .at(-1) ?? null;
          forceStop = request
            ? inThisRun
                .filter(
                  (event) =>
                    event.event === 'force-stop-before-forward' && event.key === request.key,
                )
                .at(-1) ?? null
            : null;
        }

        try {
          pid = device.adb([...target, 'shell', 'pidof', pkg], adbArgs).trim();
          pidCheckError = null;
        } catch (err) {
          // `pidof` exits 1, with no output, when the process is gone; that is the expected
          // stopped result. Anything else means adb could not answer, and calling that "stopped"
          // would report a kill that was never proved.
          const stderr = String(err?.stderr ?? '').trim();
          if (err?.status === 1 && !stderr) {
            pid = '';
            pidCheckError = null;
          } else {
            pid = '';
            pidCheckError = stderr || String(err?.message ?? err);
          }
        }

        if (request && !pid && !pidCheckError) break;
        await sleep(300);
      }

      if (!request) {
        return { status: 'fail', detail: `the proxy logged no Draft PO request in this run (journal ${journal})` };
      }
      if (!forceStop) {
        return { status: 'fail', detail: 'the proxy did not record a force-stop for the captured key' };
      }
      if (pidCheckError) {
        return { status: 'blocked', detail: `could not check whether ${pkg} stopped: ${pidCheckError}` };
      }
      if (pid) return { status: 'fail', detail: `${pkg} is still running (pid ${pid}) after the request` };
      if (!request.key) return { status: 'fail', detail: 'the captured Draft PO request has no Idempotency-Key' };

      ctx.restartRequest = request;
      return {
        status: 'pass',
        detail: `${pkg} stopped; captured ${request.key} with the exact ${Buffer.byteLength(
          JSON.stringify(request.body ?? {}),
        )}-byte body`,
      };
    }

    case 'relaunch': {
      const resolved = resolveStepText(value, ctx);
      if (resolved.missing) return { status: 'blocked', detail: `relaunch ${value} ${resolved.missing}` };
      device.openDevClient({ adbPath: ctx.adbPath, serial: ctx.serial, devServerUrl: ctx.devServerUrl });

      // A cold development build opens the Expo launcher first and loads the bundle from Metro.
      // Opening the route before that finishes is a deep link into the launcher, not into the app.
      let settled = false;
      const deadline = Date.now() + Math.max(ctx.timeoutMs, 30_000);
      while (Date.now() < deadline) {
        await sleep(1000);
        try {
          settled = !looksAtDevLauncher((await device.readScreen(adbArgs)).nodes);
        } catch {
          settled = false;
        }
        if (settled) break;
      }
      if (!settled) {
        return { status: 'fail', detail: 'the Expo dev launcher did not hand over to the app bundle' };
      }

      // A cold start can deliver the first route intent before the navigator is mounted; the app
      // then sits on its default dashboard and the deep link is lost. Re-open it until the
      // destination has actually rendered, instead of reporting pass after a blind sleep.
      let landed = false;
      let opened = 0;
      while (!landed && opened < 4) {
        device.openRoute(resolved.text, adbArgs);
        await sleep(1800);
        try {
          const screen = await device.readScreen(adbArgs);
          landed = findNodes(screen.nodes, 'Draft purchase order from restock').length > 0;
        } catch {
          landed = false;
        }
        opened += 1;
        if (!landed) await sleep(800);
      }
      if (!landed) {
        return {
          status: 'fail',
          detail: `opened ${resolved.text} ${opened} times but the destination never rendered`,
        };
      }
      return {
        status: 'pass',
        detail: `cold-started the bundle, then opened ${resolved.text}` + (opened > 1 ? ` (retry ${opened - 1})` : ''),
      };
    }

    case 'verifyDraftResume': {
      const request = ctx.restartRequest;
      if (!request) return { status: 'fail', detail: 'no captured request — expectStopped did not run first' };
      const spec = value ?? {};
      const database = resolveStepText(spec.database, ctx);
      if (database.missing) {
        return { status: 'blocked', detail: `verifyDraftResume ${spec.database} ${database.missing}` };
      }

      const body = request.body ?? {};
      if (!Array.isArray(body.items) || !body.supplierId || !body.locationId) {
        return { status: 'fail', detail: 'the captured body lacks supplierId, locationId or items' };
      }

      const script = join(ROOT, 'server', 'scripts', 'verify-draft-po-resume.mjs');
      try {
        const stdout = execFileSync(
          process.execPath,
          [
            script,
            `--database=${database.text}`,
            `--key=${request.key}`,
            `--body=${JSON.stringify(body)}`,
            '--format=json',
          ],
          { cwd: join(ROOT, 'server'), encoding: 'utf8', timeout: 60_000 },
        );
        const payload = JSON.parse(stdout);
        return { status: 'pass', detail: payload.detail };
      } catch (err) {
        let payload = null;
        try {
          payload = JSON.parse(err.stdout || '');
        } catch {
          payload = null;
        }
        const problems = Array.isArray(payload?.problems) ? payload.problems.join('; ') : '';
        const detail = problems || String(err.stderr || err.stdout || err.message || err).trim().split('\n').at(-1);
        return { status: err.status === 2 ? 'blocked' : 'fail', detail };
      }
    }

    case 'verifyTransfer': {
      if (!ctx.verifyLedger) {
        return { status: 'blocked', detail: 'the run did not ask for --verify-ledger' };
      }
      const missing = [ctx.runId, ctx.sku, ctx.source, ctx.destination].filter((v) => !v);
      if (missing.length) {
        return { status: 'blocked', detail: `transfer verification needs ${missing.join(', ')}` };
      }

      const script = join(ROOT, 'server', 'scripts', 'verify-transfer-ui.mjs');
      const scriptArgs = [
        script,
        `--run-id=${ctx.runId}`,
        `--sku=${ctx.sku}`,
        `--source=${ctx.source}`,
        `--destination=${ctx.destination}`,
        '--format=json',
      ];
      if (ctx.businessId) scriptArgs.push(`--business=${ctx.businessId}`);
      if (ctx.verifyProduction) scriptArgs.push('--with-production');

      try {
        const stdout = execFileSync(process.execPath, scriptArgs, {
          cwd: join(ROOT, 'server'),
          encoding: 'utf8',
          timeout: 60_000,
        });
        const payload = JSON.parse(stdout);
        return {
          status: 'pass',
          detail:
            `${payload.rows} row(s) reconcile; source ${payload.source.quantity}, ` +
            `destination ${payload.destination.quantity}; nothing was modified`,
        };
      } catch (err) {
        let payload = null;
        try {
          payload = JSON.parse(err.stdout || '');
        } catch {
          payload = null;
        }
        const errors = payload?.result?.errors;
        if (Array.isArray(errors) && errors.length) {
          return { status: 'fail', detail: errors.join(' | ') };
        }
        const detail = String(err.stderr || err.stdout || err.message || err)
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ');
        return { status: err.status === 2 ? 'blocked' : 'fail', detail };
      }
    }

    default:
      return { status: 'fail', detail: `the runner has no implementation for "${verb}"` };
  }
}

/** The 95-module pattern for a code, used only to validate the check digit of what is on screen. */
function moduleBitsFor(code) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const flip = (p) => p.split('').map((c) => (c === '0' ? '1' : '0')).join('');
  const R = L.map(flip);
  const G = R.map((p) => p.split('').reverse().join(''));
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const digits = code.split('').map(Number);
  if (digits.length !== 13 || digits.some((d) => Number.isNaN(d))) return '';
  const parity = PARITY[digits[0]];
  let bits = '101';
  for (let i = 0; i < 6; i += 1) bits += (parity[i] === 'L' ? L : G)[digits[i + 1]];
  bits += '01010';
  for (let i = 0; i < 6; i += 1) bits += R[digits[i + 7]];
  bits += '101';
  return bits;
}

async function runJourney(journey, options) {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const outDir = options.out ?? join(DEFAULT_EVIDENCE, `${stamp}-${journey.id}`);
  mkdirSync(outDir, { recursive: true });

  // One id ties every row this run writes together. It reaches the form through
  // the `{{runId}}` placeholder and the verifier through `--run-id`, so a repeat
  // run cannot mistake an older run's movements for its own.
  const runId = stamp;
  const stepsForRun =
    options.verifyLedger && journey.id === 'transfer'
      ? [...journey.steps, { verifyTransfer: true }]
      : journey.steps;

  const ctx = {
    outDir,
    startedAt,
    serial: options.serial,
    adbPath: options.adbPath,
    sku: options.sku,
    productName: null,
    source: options.source,
    destination: options.destination,
    supplier: options.supplier,
    location: options.location,
    product1: options.product1,
    product2: options.product2,
    proxyLog: options.proxyLog,
    devServerUrl: options.devServerUrl ?? 'http://localhost:8081',
    database: options.database,
    runId,
    verifyLedger: options.verifyLedger,
    verifyProduction: options.verifyProduction,
    businessId: options.businessId,
    timeoutMs: options.timeoutMs,
    pdfBaseline: [],
  };

  // The baseline is taken BEFORE the journey so `decodeLabel` can tell the PDF this run wrote from
  // the ones earlier runs left in the cache.
  if (stepsForRun.some((step) => step.decodeLabel)) {
    try {
      ctx.pdfBaseline = device.appPdfs({ adbPath: ctx.adbPath, serial: ctx.serial });
    } catch (err) {
      if (err instanceof DeviceUnavailable) ctx.pdfBaseline = [];
      else throw err;
    }
  }

  const steps = [];
  for (const [index, step] of stepsForRun.entries()) {
    const title = titleOf(step, ctx);
    const began = Date.now();
    let result;
    try {
      result = await runStep(step, ctx);
    } catch (err) {
      const blocked = err instanceof DeviceUnavailable;
      let shot = null;
      try {
        shot = join(outDir, `failure-${index}.png`);
        device.screenshot(shot, { adbPath: ctx.adbPath, serial: ctx.serial });
      } catch {
        shot = null;
      }
      result = {
        status: blocked ? 'blocked' : 'fail',
        detail: `${err.message}${shot ? ` (screenshot: ${shot})` : ''}`,
      };
    }

    const record = { title, status: result.status, detail: result.detail ?? '', durationMs: Date.now() - began };
    steps.push(record);
    console.log(`${record.status === 'pass' ? '✔' : record.status === 'fail' ? '✖' : '•'} ${title}${
      record.status === 'pass' ? '' : ` — ${record.detail}`
    }`);

    // A BLOCKED PRECONDITION ENDS THE JOURNEY, except for `expectData`: "this tenant has no rows"
    // says nothing about the next screen, but "this product has no barcode" means the steps after
    // it were never reached — and running them reported `expected "Barcode label"` as an app defect
    // on a product that simply has no barcode (measured 2026-10-26, the first `label` run by SKU).
    if (record.status === 'fail' && !options.keepGoing) break;
    if (record.status === 'blocked' && !step.expectData && !options.keepGoing) break;

    // `--until=N` stops after step N and writes what is on screen. A journey that fails mid-form
    // is otherwise only visible as a list of labels, and guessing the next control costs device
    // runs — this makes the screen itself the artifact.
    if (options.until != null && index >= options.until) {
      try {
        const screen = await device.readScreen({ adbPath: ctx.adbPath, serial: ctx.serial });
        writeFileSync(
          join(outDir, 'state.json'),
          `${JSON.stringify(screen.nodes.map((node) => ({ label: node.label, class: node.className, clickable: node.clickable, bounds: node.bounds })), null, 2)}\n`,
        );
      } catch {
        // A missing snapshot is not a failed step; the step results are the verdict.
      }
      break;
    }
  }

  const run = {
    journey: journey.id,
    startedAt,
    runId,
    device: options.deviceLabel,
    steps,
    notes: `evidence: ${outDir}`,
  };

  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), summariseRun(run));
  return { run, outDir, exitCode: exitCodeFor(steps) };
}

/**
 * Does the app's own list screen report a rejected session?
 *
 * The dashboard can render from cached state while every list is failing, so the check looks at a
 * screen that actually asks the server and prints the answer.
 *
 * It WAITS FOR THE SCREEN TO SETTLE rather than sleeping a fixed 2.5s and reading once. Measured
 * on 2026-10-22: the reproduction run's preflight read the inventory screen before its banner had
 * rendered, saw neither banner nor data, and let a run where every request was refused `401`
 * proceed — the check existed and looked too early. The loop ends as soon as the screen reports
 * rows, an empty state or an error, so the common case is faster than the old fixed wait.
 */
async function appRejectsSession(args) {
  try {
    device.openRoute('inventoryai://inventory', { adbPath: args.adbPath, serial: args.serial });
    const deadline = Date.now() + 10_000;

    for (;;) {
      await sleep(700);
      let nodes;
      try {
        nodes = (await device.readScreen({ adbPath: args.adbPath, serial: args.serial })).nodes;
      } catch {
        nodes = null;
      }

      if (nodes) {
        if (looksSessionExpired(nodes)) return true;
        // Rows, an empty list or an ordinary error all mean the screen has finished answering:
        // none of them is "the app still holds a session the server refuses".
        if (rowsMatching(nodes, INVENTORY_ROW).length) return false;
        const state = describeListState(nodes).state;
        if (state === 'empty' || state === 'error') return false;
      }

      if (Date.now() >= deadline) return false;
    }
  } catch {
    return false;
  }
}

function selfTest() {
  const problems = [...validateJourneys(JOURNEYS)];

  // Controls: each of these must be refused, or the validator is decorative.
  const bad = [
    [{ id: 'x', summary: 's', steps: [{ teleport: 1 }] }],
    [{ id: 'x', summary: 's', steps: [] }],
    [{ id: 'x', summary: 's', steps: [{ tap: 'A', expect: 'B' }] }],
    [{ id: 'x', summary: 's', steps: [{ findProduct: {} }] }],
    [{ id: 'x', summary: 's', steps: [{ pick: { field: 'A', sheet: 'B' } }] }],
  ];
  for (const table of bad) {
    if (validateJourneys(table).length === 0) problems.push(`control not caught: ${JSON.stringify(table)}`);
  }

  // Controls on the verdicts themselves.
  if (exitCodeFor([{ status: 'pass' }]) !== 0) problems.push('a clean run did not exit 0');
  if (exitCodeFor([{ status: 'fail' }]) !== 1) problems.push('a failure did not exit 1');
  if (exitCodeFor([{ status: 'blocked' }]) !== 2) problems.push('a blocked step did not exit 2');
  if (escapeInputText('a b') !== 'a%sb') problems.push('a space is not encoded for input text');

  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.unknown?.length) {
    console.error(`unknown option(s): ${args.unknown.join(', ')}`);
    process.exit(2);
  }

  if (args.selfTest) {
    const problems = selfTest();
    if (problems.length) {
      console.error('✖ the harness\'s own controls failed:');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`✔ ${JOURNEYS.length} journeys, ${JOURNEYS.reduce((n, j) => n + j.steps.length, 0)} steps, controls pass`);
    process.exit(0);
  }

  if (args.list) {
    for (const journey of JOURNEYS) {
      const writes = WRITE_JOURNEYS.includes(journey.id) ? ' (writes)' : '';
      console.log(`${journey.id.padEnd(8)} ${journey.steps.length} steps${writes} — ${journey.summary}`);
    }
    process.exit(0);
  }

  const journeys = chosenJourneys(args);
  if (!journeys.length) {
    console.error('no journey matched; try --list');
    process.exit(2);
  }
  const blockedByWrites = journeys.filter((j) => WRITE_JOURNEYS.includes(j.id));
  if (blockedByWrites.length && !args.allowWrites) {
    console.error(
      `refusing to run ${blockedByWrites.map((j) => j.id).join(', ')}: it writes to the tenant. Pass --allow-writes.`,
    );
    process.exit(2);
  }
  // This journey deliberately force-stops the app and writes a DRAFT. Do not
  // let adb auto-select a phone for it; the install incident proved how costly
  // an implicit "only connected device" can be.
  if (journeys.some((j) => j.id === 'draft-resume') && !args.serial) {
    console.error('refusing draft-resume without an explicit --serial=<device>; automatic selection is not allowed.');
    process.exit(2);
  }

  const problems = validateJourneys(JOURNEYS);
  if (problems.length) {
    console.error(`✖ the journey table is invalid:\n  - ${problems.join('\n  - ')}`);
    process.exit(2);
  }

  let info;
  try {
    info = device.deviceInfo({ adbPath: args.adbPath, serial: args.serial });
  } catch (err) {
    console.error(`✖ cannot check: ${err.message}`);
    process.exit(2);
  }

  if (args.serial == null) args.serial = info.serial;
  args.deviceLabel = `${info.model} · Android ${info.release} (API ${info.sdk}) · ${info.serial}`;

  // The tunnels are the difference between "the app is broken" and "the phone cannot reach us".
  const tunnels = device.reverseList({ adbPath: args.adbPath, serial: args.serial });
  if (!tunnels.some((line) => line.includes('tcp:4000'))) {
    console.error(
      '✖ cannot check: port 4000 is not forwarded to the phone.\n' +
        '  Fix:  adb reverse tcp:4000 tcp:4000 && adb reverse tcp:8081 tcp:8081',
    );
    process.exit(2);
  }

  console.log(`device: ${args.deviceLabel}`);
  console.log(`tunnels: ${tunnels.join(', ')}`);

  // Signed-out is a precondition, not a defect: the app is running and fine, it just has no
  // session. Report it as "could not check" and say exactly what to do, instead of failing the
  // first journey step with a screen dump that reads like a bug.
  try {
    device.openRoute('inventoryai://dashboard', { adbPath: args.adbPath, serial: args.serial });
    await sleep(1500);
    let screen = await device.readScreen({ adbPath: args.adbPath, serial: args.serial });

    // A cold-started development build opens the Expo dev launcher, not the app, and the route deep
    // link above cannot reach an app that is not running — so the harness starts the bundle the way
    // tapping the server entry does. If the launcher is STILL there, nothing about the app has been
    // observed: that is a blocked run with something to do about it, never an app defect.
    if (looksAtDevLauncher(screen.nodes)) {
      console.log('the Expo dev launcher is in front; starting the bundle…');
      device.openDevClient({ adbPath: args.adbPath, serial: args.serial });

      // The bundle loads over the tunnel, so the first reads can fail or still show the launcher.
      // Look for a bounded while instead of blocking on a screen that is merely still loading —
      // but never wait forever.
      let settled = false;
      for (let attempt = 0; attempt < 14 && !settled; attempt += 1) {
        await sleep(2500);
        try {
          screen = await device.readScreen({ adbPath: args.adbPath, serial: args.serial });
          settled = !looksAtDevLauncher(screen.nodes);
        } catch {
          settled = false;
        }
      }

      if (!settled) {
        console.error(
          '✖ cannot check: the Expo dev launcher is showing and the app did not start.\n' +
            '  Start Metro (npx expo start --dev-client), select the dev server in the launcher,\n' +
            '  then re-run. Nothing was judged about the app.',
        );
        process.exit(2);
      }

      // The bundle came up on whatever route it was left on; start the preflight from the dashboard.
      device.openRoute('inventoryai://dashboard', { adbPath: args.adbPath, serial: args.serial });
      await sleep(1500);
      screen = await device.readScreen({ adbPath: args.adbPath, serial: args.serial });
    }

    // A confirmation left open by an earlier journey (or by a person) covers the first screen and
    // every assertion after it. Clearing it here is not a workaround for an app defect: the dialog
    // is the app's own "order created" notice, and this driver is the one who left it.
    const labels = screen.nodes.map((node) => node.label);
    if (labels.includes('OK') && !labels.some((label) => /Overview/.test(label))) {
      const ok = findTapTarget(screen.nodes, 'OK', { exact: true });
      if (ok) {
        console.log('clearing a dialog left open: ' + labels.slice(0, 2).join(' — '));
        device.tap(ok.center.x, ok.center.y, { adbPath: args.adbPath, serial: args.serial });
        await sleep(800);
        screen = await device.readScreen({ adbPath: args.adbPath, serial: args.serial });
      }
    }

    if (looksSignedOut(screen.nodes)) {
      console.error(
        '✖ cannot check: the app is on its login screen, so it has no session.\n' +
          '  Sign in on the phone (the harness does not hold credentials), then re-run.',
      );
      process.exit(2);
    }

    // A stored session the server no longer accepts is not a signed-out app: it stays on the main
    // screens and every list comes back empty, which would otherwise fail steps for the wrong
    // reason. Check the screen the harness itself navigates to first, then the one that says it.
    const expiredHere = looksSessionExpired(screen.nodes);
    if (expiredHere || (await appRejectsSession(args))) {
      console.error(
        '✖ cannot check: the app holds a session the server no longer accepts ("Session expired").\n' +
          '  Sign in on the phone again, then re-run — every picker is empty until you do.',
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`✖ cannot check: could not read the app's first screen — ${err.message}`);
    process.exit(2);
  }

  let worst = 0;
  const results = [];
  for (const journey of journeys) {
    console.log(`\n=== ${journey.id} — ${journey.summary}`);
    const { outDir, exitCode, run } = await runJourney(journey, args);
    results.push({ journey: journey.id, outDir, exitCode, steps: run.steps });
    console.log(`report: ${outDir}`);
    if (exitCode === 1) worst = 1;
    else if (exitCode === 2 && worst === 0) worst = 2;
    if (exitCode !== 0 && !args.keepGoing) break;
  }

  console.log('');
  for (const result of results) {
    const passed = result.steps.filter((s) => s.status === 'pass').length;
    console.log(
      `${result.journey}: ${passed}/${result.steps.length} steps passed — exit ${result.exitCode} — ${result.outDir}`,
    );
  }
  process.exit(worst);
}

await main();

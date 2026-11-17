#!/usr/bin/env node
/**
 * Rebuild the printable two-contact notification checklist.
 *
 * The Markdown file is the source of truth. This script renders it through a
 * pinned Markdown parser and Chrome's print engine, verifies the PDF is exactly
 * one Letter-size page, checks the required fields, and only then replaces the
 * checked-in PDF. It never edits the checklist content.
 *
 * Free tools only:
 *   - Node 24
 *   - npx marked@18.2.1 (downloads on first use; no package is added)
 *   - Google Chrome (or CHROME_PATH)
 *   - pdftotext from Poppler (or PDFTOTEXT)
 *
 * Usage: node scripts/render-notification-checklist.mjs
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'docs', 'PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.md');
const TARGET = path.join(ROOT, 'docs', 'PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf');
const REQUIRED_TEXT = [
  'Test ID',
  'Primary contact',
  'Cucumber',
  'Owner signature',
  'STOP',
  'written acknowledgement',
  'redacted',
];

function fail(message) {
  throw new Error(message);
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next executable.
    }
  }
  fail('Chrome/Edge was not found. Set CHROME_PATH to the browser executable.');
}

function pdftotextExecutable() {
  return process.env.PDFTOTEXT || 'pdftotext';
}

function render() {
  if (!existsSync(SOURCE)) fail(`Checklist source is missing: ${SOURCE}`);
  const temp = mkdtempSync(path.join(tmpdir(), 'inventory-ai-checklist-'));
  const bodyPath = path.join(temp, 'body.html');
  const htmlPath = path.join(temp, 'checklist.html');
  const pdfPath = path.join(temp, 'checklist.pdf');
  const npx = 'npx';
  const chrome = chromeExecutable();
  const pdftotext = pdftotextExecutable();

  try {
    const npxArgs = ['--yes', 'marked@18.2.1', '-i', SOURCE, '-o', bodyPath];
    if (process.platform === 'win32') {
      const command = `npx --yes marked@18.2.1 -i ${SOURCE} -o ${bodyPath}`;
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], {
        stdio: 'inherit',
      });
    } else {
      execFileSync(npx, npxArgs, { stdio: 'inherit' });
    }
    const body = readFileSync(bodyPath, 'utf8');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Inventory AI - two-contact notification test checklist</title>
<style>
  @page { size: Letter; margin: 0.42in 0.48in; }
  html, body { margin: 0; padding: 0; color: #111; background: #fff; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.2pt; line-height: 1.26; }
  h1 { font-size: 15.5pt; line-height: 1.15; margin: 0 0 3pt; padding-bottom: 3pt; border-bottom: 1.6pt solid #111; }
  p { margin: 2.5pt 0; }
  h2 { font-size: 9.8pt; text-transform: uppercase; letter-spacing: 0.35pt; margin: 7pt 0 2.5pt; padding-bottom: 1.5pt; border-bottom: 0.6pt solid #777; }
  ul { margin: 2pt 0; padding-left: 13pt; }
  li { margin: 1.2pt 0; }
  li input[type="checkbox"] { width: 8.5pt; height: 8.5pt; margin: 0 2pt 0 0; vertical-align: -0.5pt; }
  table { width: 100%; border-collapse: collapse; margin: 3pt 0 4pt; font-size: 8.7pt; }
  th, td { border: 0.55pt solid #555; padding: 2.3pt 3pt; text-align: left; vertical-align: top; }
  th { background: #ececec; font-weight: bold; }
  blockquote { margin: 4pt 0 2pt; padding: 3.5pt 6pt; border-left: 2.5pt solid #555; background: #f1f1f1; font-size: 8.8pt; }
  blockquote p { margin: 0; }
  a { color: #111; text-decoration: none; }
  @media screen { body { max-width: 7.5in; margin: 24px auto; font-size: 11pt; } }
</style></head><body>
${body}
</body></html>`;
    writeFileSync(htmlPath, html, 'utf8');
    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { stdio: 'inherit' }
    );

    let text;
    try {
      text = execFileSync(pdftotext, ['-layout', pdfPath, '-'], {
        encoding: 'utf8',
      });
    } catch {
      fail('pdftotext could not read the PDF. Install Poppler or set PDFTOTEXT.');
    }
    const pageCount = text.split('\f').length - (text.endsWith('\f') ? 1 : 0);
    if (pageCount !== 1) {
      fail(`Expected exactly 1 page, got ${pageCount}. The PDF was not replaced.`);
    }
    if (text.includes('\uFFFD')) {
      fail('The PDF contains replacement characters. The PDF was not replaced.');
    }
    for (const needle of REQUIRED_TEXT) {
      if (!text.includes(needle)) {
        fail(`Required text "${needle}" is missing. The PDF was not replaced.`);
      }
    }

    copyFileSync(pdfPath, TARGET);
    console.log(`Verified exactly 1 page; wrote ${path.relative(ROOT, TARGET)} (${statSync(TARGET).size} bytes).`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

try {
  render();
} catch (error) {
  console.error(`[checklist] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

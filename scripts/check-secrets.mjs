#!/usr/bin/env node
/**
 * Secret guard — fails when a credential-shaped string enters the tracked tree.
 *
 * WHY THIS EXISTS
 * GitHub's secret scanning and push protection are enabled now that this repository is
 * **public**, but they are pattern matching over the hosted history. The same job is also
 * done here, at the level that matters for this project: a change that would commit a real
 * credential fails CI instead of being noticed later, and the guard's controls run before
 * every scan.
 *
 * WHAT IT IS NOT
 * It is pattern matching over tracked file contents. It cannot see a credential that is
 * committed *obfuscated*, split across lines, or stored in a value that looks like data.
 * It is a net for the common, high-signal shapes — not a proof that a commit is clean.
 * See docs/SOURCE_PROTECTION.md for what this does and does not protect.
 *
 * DESIGN NOTES, all deliberate:
 *   * High-signal patterns only. A generic "assignment to something called SECRET" rule
 *     was rejected because the suites contain fixed, non-secret test values on purpose
 *     (e.g. JWT_SECRET in .github/workflows/ci.yml), and a scanner that red-lights
 *     deliberate fixtures is a scanner people learn to bypass.
 *   * A private key block is judged by its BODY LENGTH, not its header: the Firebase
 *     suites legitimately carry dummy PEM blocks with bodies like `abc` or `MIIabc`,
 *     while a real key body is well over a thousand characters.
 *   * Every finding can be waived **on the line itself** with `secret-guard:allow`, so a
 *     deliberate exception is visible in review instead of being hidden in a list here.
 *
 * USAGE
 *   node scripts/check-secrets.mjs              # every tracked file (what CI runs)
 *   node scripts/check-secrets.mjs path...      # explicit files (used by the self-test)
 *   node scripts/check-secrets.mjs --self-test  # the canaries only — no tree scan
 *
 * WHY THE SELF-TEST LIVES HERE AND RUNS ON EVERY INVOCATION. A guard whose rules have quietly stopped
 * matching is a green run that detects nothing, and this guard is this repository's only credential
 * control, so the controls run before the scan rather than beside it — CI needs no second command. The
 * project's history scan already taught the lesson — *"a scan that cannot fail proves nothing"*, so it
 * was run with a positive control that had to be found and a negative canary that must not be — and
 * the guard's own first version had exactly such a bug, found only by running it against the real
 * tree (a CRLF offset drift that misread a dummy PEM as a real key). So the canaries are here, one
 * must-fire and a set of must-not-fire cases, and they run on every invocation; see `selfTest()`.
 *
 * Exit codes: 0 clean, 1 findings or a failed self-test, 2 could not run.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WAIVER = /secret-guard:allow/;

/** Skip content that cannot be a credential and is expensive to scan. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svgz', 'ttf', 'otf', 'woff', 'woff2',
  'eot', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'pdf', 'jar', 'apk', 'aab', 'ipa', 'so', 'dylib',
  'dll', 'exe', 'bin', 'class', 'jks', 'keystore', 'p12', 'pfx', 'xlsx', 'docx', 'mp4', 'mov',
]);
const MAX_BYTES = 2 * 1024 * 1024;

/** A PEM block is only a real key when its body is long enough to be one. */
const MIN_KEY_BODY = 200;

const RULES = [
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, pem: true },
  { name: 'mongodb-uri-with-credentials', re: /mongodb(?:\+srv)?:\/\/[^\s:'"`/]+:[^\s@'"`]+@/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'openai-or-anthropic-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'resend-key', re: /\bre_[A-Za-z0-9_]{20,}\b/ },
  { name: 'brevo-key', re: /\bxkeysib-[A-Za-z0-9-]{20,}\b/ },
  { name: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{30,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  {
    name: 'firebase-service-account',
    re: /"type"\s*:\s*"service_account"/,
  },
  {
    name: 'signed-jwt',
    re: /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  },
];

/** A tracked env file is a finding regardless of content — `.env.example` is the exception. */
function isForbiddenEnvFile(path) {
  const parts = path.split(/[\\/]/);
  const base = parts[parts.length - 1];
  if (base === '.env.example') return false;
  return /^\.env(\..+)?$/.test(base);
}

function mask(value) {
  const cleaned = value.trim();
  return cleaned.length <= 8 ? cleaned : `${cleaned.slice(0, 4)}…(${cleaned.length} chars)`;
}

/** A PEM header is only reported when a real body follows it. */
function pemBodyIsReal(content, index) {
  const rest = content.slice(index);
  const end = rest.indexOf('-----END');
  const body = (end === -1 ? rest : rest.slice(0, end)).replace(/[^A-Za-z0-9+/=]/g, '');
  return body.length >= MIN_KEY_BODY;
}

function relative(path) {
  return path.startsWith('./') ? path.slice(2) : path;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function scanFile(displayPath, findings) {
  const ext = displayPath.split('.').pop().toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return;

  let content;
  try {
    const stat = readFileSync(displayPath, { encoding: 'utf8', flag: 'r' });
    content = stat;
  } catch {
    return; // unreadable (deleted, binary-as-UTF8 failure) — not this tool's concern
  }
  if (content.length > MAX_BYTES) return;

  const lines = content.split(/\r\n|\n|\r/);
  let searchFrom = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Locate each line by searching, rather than by arithmetic. The first version of
    // this file assumed LF endings and advanced the offset by `line.length + 1`, which
    // drifts by one character per preceding CRLF line — on this repository that made the
    // private-key body test read from the wrong offset and report a dummy
    // `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----` fixture as a real key.
    // Found by running the guard against the real tree, not by reading it.
    const found = content.indexOf(line, searchFrom);
    const lineIndexInContent = found === -1 ? searchFrom : found;
    searchFrom = lineIndexInContent + line.length;
    if (WAIVER.test(line)) continue;

    for (const rule of RULES) {
      const match = rule.re.exec(line);
      if (!match) continue;
      if (rule.pem && !pemBodyIsReal(content, lineIndexInContent + match.index)) continue;
      findings.push({
        path: displayPath,
        line: i + 1,
        rule: rule.name,
        preview: mask(match[0]),
      });
    }
  }
}

/** Scan explicit paths — the single code path both the real run and the self-test go through. */
function scanPaths(paths) {
  const findings = [];
  for (const path of paths) {
    if (isForbiddenEnvFile(path)) {
      findings.push({ path, line: 1, rule: 'tracked-env-file', preview: 'a real .env must never be tracked' });
      continue;
    }
    scanFile(path, findings);
  }
  return findings;
}

/**
 * Every rule must still fire, every must-not-fire shape must stay quiet, and a waiver must suppress
 * exactly its own line. Run automatically on every invocation (CI included) and by name with
 * `--self-test`; the temporary files live outside the repository and are removed here.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-guard-selftest-'));
  const longBody = 'A'.repeat(MIN_KEY_BODY + 24);

  const cases = [
    // One must-fire case per rule, so a rule that stops matching is caught here, not by a leak.
    { file: 'private-key.txt', content: `-----BEGIN PRIVATE KEY-----\n${longBody}\n-----END PRIVATE KEY-----\n`, expect: ['private-key-block'] },
    { file: 'mongodb-uri.txt', content: 'MONGODB_URI=mongodb+srv://canary:canary@cluster0.example.mongodb.net/db\n', expect: ['mongodb-uri-with-credentials'] }, // secret-guard:allow (self-test canary — this line defines the shape the guard must flag in a scanned file, and waives only itself)
    { file: 'google-api-key.txt', content: `AIza${'A'.repeat(35)}\n`, expect: ['google-api-key'] },
    { file: 'aws-key.txt', content: `AKIA${'B'.repeat(16)}\n`, expect: ['aws-access-key-id'] },
    { file: 'provider-key.txt', content: `sk-${'c'.repeat(24)}\n`, expect: ['openai-or-anthropic-key'] },
    { file: 'resend-key.txt', content: `re_${'d'.repeat(24)}\n`, expect: ['resend-key'] },
    { file: 'brevo-key.txt', content: `xkeysib-${'e'.repeat(24)}\n`, expect: ['brevo-key'] },
    { file: 'sendgrid-key.txt', content: `SG.${'f'.repeat(16)}.${'g'.repeat(16)}\n`, expect: ['sendgrid-key'] },
    { file: 'github-token.txt', content: `ghp_${'h'.repeat(36)}\n`, expect: ['github-token'] },
    { file: 'github-pat.txt', content: `github_pat_${'i'.repeat(36)}\n`, expect: ['github-fine-grained-pat'] },
    { file: 'slack-token.txt', content: `xoxb-${'1'.repeat(14)}\n`, expect: ['slack-token'] },
    { file: 'stripe-key.txt', content: `sk_live_${'j'.repeat(24)}\n`, expect: ['stripe-secret-key'] },
    { file: 'service-account.json', content: '{"type": "service_account", "project_id": "canary"}\n', expect: ['firebase-service-account'] }, // secret-guard:allow (self-test canary — same rule: the string must exist here, the temp file it is written to is unwaved)
    { file: 'signed-jwt.txt', content: `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.${'k'.repeat(16)}\n`, expect: ['signed-jwt'] },
    { file: '.env', content: 'ANYTHING=1\n', expect: ['tracked-env-file'] },

    // Must-NOT-fire: the deliberate shapes this guard was built to tolerate.
    { file: 'too-short.txt', content: `sk-abc re_short AIza${'A'.repeat(10)} xoxb-1\n`, expect: [] },
    { file: 'local-mongodb.txt', content: 'MONGODB_URI=mongodb://localhost:27017/inventoryai_test_db\n', expect: [] },
    { file: '.env.example', content: 'MONGODB_URI=\n', expect: [] },
    // The shape the guard's first bug misread: a dummy PEM whose body is `abc`, on a file whose
    // OTHER content is long enough that an offset mistake would swallow it as the key body.
    {
      file: 'dummy-pem-with-padding.txt',
      content: `${'const padding = "' + 'x'.repeat(400) + '";\r\n'}const key = \`-----BEGIN PRIVATE KEY-----\r\nabc\r\n-----END PRIVATE KEY-----\`;\r\n${'const more = "' + 'y'.repeat(400) + '";\r\n'}`,
      expect: [],
    },
    // The shape, in both directions, with CRLF endings — deliberately NOT the exact boundary.
    // The threshold (~185 body characters once the header's letters are counted) sits far below any
    // realistic key, whose body is over a thousand characters, and a control that pinned the precise
    // cutoff would pin an accident rather than the promise. Short is quiet; realistic is caught.
    { file: 'pem-clearly-short.txt', content: `-----BEGIN PRIVATE KEY-----\r\n${'A'.repeat(100)}\r\n-----END PRIVATE KEY-----\r\n`, expect: [] },
    { file: 'pem-clearly-real.txt', content: `-----BEGIN PRIVATE KEY-----\r\n${'A'.repeat(400)}\r\n-----END PRIVATE KEY-----\r\n`, expect: ['private-key-block'] },
    // A waiver suppresses its own line and nothing else.
    { file: 'waived.txt', content: `sk-${'c'.repeat(24)} // secret-guard:allow (self-test)\n`, expect: [] },
  ];

  let failures = 0;
  for (const testCase of cases) {
    const path = join(dir, testCase.file);
    writeFileSync(path, testCase.content, 'utf8');
    const found = scanPaths([path]).map((finding) => finding.rule).sort();
    const expected = [...testCase.expect].sort();
    const ok = found.length === expected.length && found.every((rule, i) => rule === expected[i]);
    if (!ok) {
      failures += 1;
      console.log(`::error::self-test ${testCase.file}: expected [${expected.join(', ') || 'clean'}], got [${found.join(', ') || 'clean'}]`);
    }
  }
  rmSync(dir, { recursive: true, force: true });

  const mustFire = cases.filter((c) => c.expect.length > 0).length;
  if (failures > 0) {
    console.log(`secret-guard self-test: ${failures} of ${cases.length} control(s) FAILED — a rule or a waiver is broken; do not trust this run.`);
    return 1;
  }
  console.log(`secret-guard self-test: ${cases.length} control(s) passed (${mustFire} must-fire, ${cases.length - mustFire} must-not-fire)`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const controls = selfTest();
  if (args.includes('--self-test')) return controls;
  // A broken control run stops here: scanning a tree with rules that no longer fire would print
  // "no credential-shaped content found" for a tree that contains one.
  if (controls !== 0) return controls;

  const explicit = args.filter((a) => !a.startsWith('-'));
  const files = explicit.length > 0 ? explicit.map(relative) : trackedFiles();

  const findings = scanPaths(files);

  console.log(`secret-guard: scanned ${files.length} file(s)`);
  if (findings.length === 0) {
    console.log('secret-guard: no credential-shaped content found');
    return 0;
  }

  for (const f of findings) {
    console.log(`::error file=${f.path},line=${f.line}::${f.rule} in ${f.path}:${f.line} (${f.preview})`);
  }
  console.log('');
  console.log(`secret-guard: ${findings.length} finding(s).`);
  console.log('If a finding is a deliberate test fixture, add `secret-guard:allow` to that line;');
  console.log('otherwise remove the credential, rotate it, and assume it was exposed.');
  return 1;
}

process.exitCode = main();

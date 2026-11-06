/**
 * Documentation links — every relative Markdown target must resolve.
 *
 * WHY THIS EXISTS. The documentation is split into guides, reference pages and dated records, and each
 * one links to the others. A removed guide, a renamed evidence folder or a path written from the wrong
 * directory leaves a reader at a 404 while every command-name and fact guard still passes. The link
 * check is deliberately structural: it proves the target path exists, not that the destination still
 * says what the sentence claims.
 *
 * WHAT IT IS NOT. It does not fetch HTTP(S) links, validate anchors or judge prose. It scans the
 * repository's Markdown (the root pages and `docs/`) and skips local-only/dependency directories.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKIP_DIRS = new Set([
  '.git',
  '.freebuff',
  '.scratch',
  '.smoke',
  '.expo',
  'node_modules',
  'coverage',
  'dist',
  'build',
]);

function markdownFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) markdownFiles(full, files);
    else if (name.endsWith('.md')) files.push(full);
  }
  return files;
}

/** Every Markdown link target whose path is relative to the containing file. */
function relativeLinks(text) {
  return [...String(text).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => target && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target))
    .map((target) => target.split('#')[0].split('?')[0])
    .filter(Boolean);
}

function brokenLinks(files) {
  const broken = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const target of relativeLinks(text)) {
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        broken.push(`${file} -> ${target} (invalid URL encoding)`);
        continue;
      }
      if (!existsSync(resolve(dirname(file), decoded))) broken.push(`${file} -> ${target}`);
    }
  }
  return broken;
}

const FILES = markdownFiles(ROOT);

describe('documentation links', () => {
  test('the scan is actually reading the documentation', () => {
    assert.ok(FILES.length > 50, `only ${FILES.length} Markdown files found`);
    assert.ok(relativeLinks('[a](README.md) [b](https://example.com)').length === 1);
  });

  test('★ every relative Markdown link resolves to a path on disk', () => {
    const broken = brokenLinks(FILES);
    assert.deepEqual(broken, [], `broken documentation links:\n${broken.join('\n')}`);
  });
});

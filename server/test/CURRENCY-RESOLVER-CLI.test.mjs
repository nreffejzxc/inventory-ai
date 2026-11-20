// §27KL — The operator command's contract, without a live database.
//
// `currency-required-and-marketplace.test.mjs` proves what the resolution
// service does. This file proves the command that invokes it: template mode is
// read-only, dry-run is the default, `--apply` is the only write path, a
// 5,000-row template states that it was truncated, and the documented 0/1/2
// exit codes stay stable when arguments, the target database, the connection,
// the evidence file or the report are wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../scripts/resolve-product-currency.mjs';

const DATABASES = {
  development: 'inventoryai_dev_db',
  test: 'inventoryai_test_db',
  production: 'inventoryai_prod_db',
};
const BUSINESS_ID = '64f000000000000000000001';
const PRODUCT_ID = '64f000000000000000000002';

function evidence(overrides = {}) {
  return {
    version: 1,
    businessId: BUSINESS_ID,
    reviewedBy: 'Owner review',
    reviewedAt: '2026-11-20T10:00:00.000Z',
    source: 'Supplier invoice pack 2026-11-19',
    entries: [
      {
        productId: PRODUCT_ID,
        expectedName: 'Legacy kettle',
        currency: 'PHP',
        evidence: 'Invoice INV-100 line 1',
      },
    ],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    reviewedBy: 'Owner review',
    reviewedAt: '2026-11-20T10:00:00.000Z',
    source: 'Supplier invoice pack 2026-11-19',
    dryRun: true,
    resolved: 0,
    wouldResolve: 0,
    alreadyResolved: 0,
    conflicts: 0,
    notFound: 0,
    nameMismatches: 0,
    failed: 0,
    rows: [],
    ...overrides,
  };
}

function capture() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
      return true;
    },
    text() {
      return text;
    },
  };
}

async function run({
  argv = [],
  envConfig = { mongodbUri: 'mongodb://example.test', mongodbDbName: DATABASES.development },
  candidates = async () => ({ items: [], truncated: false, limit: 5_000 }),
  resolveCurrencies = async ({ apply }) => report({ dryRun: !apply }),
  connect = async () => {},
  disconnect = async () => {},
  readFile = () => JSON.stringify(evidence()),
  writeFile = () => {},
  selectDatabases = () => [DATABASES.development],
} = {}) {
  const stdout = capture();
  const stderr = capture();
  const calls = {
    candidates: [],
    resolve: [],
    connect: [],
    disconnect: 0,
    readFile: [],
    writeFile: [],
    select: 0,
  };
  const code = await runCli({
    argv,
    envConfig,
    databaseNames: DATABASES,
    selectDatabases: (...args) => {
      calls.select += 1;
      return selectDatabases(...args);
    },
    connect: async (...args) => {
      calls.connect.push(args);
      return connect(...args);
    },
    disconnect: async () => {
      calls.disconnect += 1;
      return disconnect();
    },
    readCandidates: async (options) => {
      calls.candidates.push(options);
      return candidates(options);
    },
    resolveCurrencies: async (options) => {
      calls.resolve.push(options);
      return resolveCurrencies(options);
    },
    readFile: (...args) => {
      calls.readFile.push(args);
      return readFile(...args);
    },
    writeFile: (...args) => {
      calls.writeFile.push(args);
      return writeFile(...args);
    },
    stdout,
    stderr,
  });
  return { code, calls, stdout: stdout.text(), stderr: stderr.text() };
}

describe('resolve:product-currency CLI', () => {
  it('prints an empty review template and exits 0 without a write', async () => {
    const result = await run({
      argv: ['--template', `--business=${BUSINESS_ID}`],
    });

    assert.equal(result.code, 0);
    const template = JSON.parse(result.stdout);
    assert.equal(template.version, 1);
    assert.equal(template.businessId, BUSINESS_ID);
    assert.equal(template.reviewedBy, '');
    assert.equal(template.source, '');
    assert.deepEqual(template.entries, []);
    assert.equal(result.calls.resolve.length, 0);
    assert.equal(result.calls.writeFile.length, 0);
  });

  it('prints a review template with blank decisions and exits 1 when rows need review', async () => {
    const result = await run({
      argv: ['--template', `--business=${BUSINESS_ID}`],
      candidates: async () => ({
        items: [{ _id: PRODUCT_ID, name: 'Legacy kettle', sku: 'K-1' }],
        truncated: false,
        limit: 5_000,
      }),
    });

    assert.equal(result.code, 1, 'rows needing review are exit 1');
    const template = JSON.parse(result.stdout);
    assert.equal(template.entries.length, 1);
    assert.equal(template.entries[0].productId, PRODUCT_ID);
    assert.equal(template.entries[0].expectedName, 'Legacy kettle');
    assert.equal(template.entries[0].currency, '');
    assert.equal(template.entries[0].evidence, '');
    assert.equal(result.calls.resolve.length, 0);
    assert.equal(result.calls.candidates[0].businessId, BUSINESS_ID);
    assert.equal(result.calls.candidates[0].limit, 5_000);
  });

  it('warns clearly when a template is truncated at 5,000 rows', async () => {
    const result = await run({
      argv: ['--template', `--business=${BUSINESS_ID}`],
      candidates: async () => ({
        items: [{ _id: PRODUCT_ID, name: 'Legacy kettle' }],
        truncated: true,
        limit: 5_000,
      }),
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /WARNING: review template truncated at 5,000 rows/);
    assert.match(result.stderr, /rerun --template for the next one/);
    assert.match(result.stdout, /"productId": "64f000000000000000000002"/);
  });

  it('writes a template to --out and keeps the truncation warning on stderr', async () => {
    const result = await run({
      argv: ['--template', `--business=${BUSINESS_ID}`, '--out=currency-review.json'],
      candidates: async () => ({
        items: [{ _id: PRODUCT_ID, name: 'Legacy kettle' }],
        truncated: true,
        limit: 5_000,
      }),
    });

    assert.equal(result.code, 1);
    assert.equal(result.calls.writeFile.length, 1);
    assert.ok(result.calls.writeFile[0][0].endsWith('currency-review.json'));
    assert.match(result.calls.writeFile[0][1], /"businessId": "64f000000000000000000001"/);
    assert.match(result.stdout, /Wrote a read-only review template/);
    assert.match(result.stderr, /truncated at 5,000 rows/);
  });

  it('defaults to a dry run and never asks the service to apply', async () => {
    const result = await run({
      argv: ['--evidence=currency-review.json'],
      resolveCurrencies: async ({ apply }) => {
        assert.equal(apply, false);
        return report({ dryRun: true, wouldResolve: 1 });
      },
    });

    assert.equal(result.code, 1, 'a dry run that would change a row is exit 1');
    assert.equal(result.calls.resolve[0].apply, false);
    assert.match(result.stdout, /Product currency resolution \(DRY RUN\)/);
    assert.match(result.stdout, /No writes were made/);
  });

  it('sends write intent only when --apply is explicit', async () => {
    const result = await run({
      argv: ['--evidence=currency-review.json', '--apply'],
      resolveCurrencies: async ({ apply }) => {
        assert.equal(apply, true);
        return report({ dryRun: false, resolved: 1 });
      },
    });

    assert.equal(result.code, 0, 'a clean apply is exit 0');
    assert.equal(result.calls.resolve[0].apply, true);
    assert.match(result.stdout, /Product currency resolution \(APPLY\)/);
    assert.match(result.stdout, /resolved\s+1/);
  });

  it('returns 1 when any apply or dry-run row remains unresolved', async () => {
    for (const field of ['conflicts', 'notFound', 'nameMismatches', 'failed', 'wouldResolve']) {
      const result = await run({
        argv: ['--evidence=currency-review.json', '--apply'],
        resolveCurrencies: async () => report({ dryRun: false, [field]: 1 }),
      });
      assert.equal(result.code, 1, `${field} must remain visible as exit 1`);
    }
  });

  it('returns 2 for invalid arguments before selecting or connecting', async () => {
    for (const argv of [
      ['--template'],
      ['--template', `--business=${BUSINESS_ID}`, '--apply'],
      ['--template', `--business=${BUSINESS_ID}`, '--evidence=file.json'],
      ['--not-a-flag'],
      ['--evidence=currency-review.json', '--out=ignored.json'],
      ['--evidence=currency-review.json', `--business=${BUSINESS_ID}`],
    ]) {
      const result = await run({ argv });
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, /NOT CHECKED \(exit 2\)/);
      assert.equal(result.calls.select, 0);
      assert.equal(result.calls.connect.length, 0);
      assert.equal(result.calls.resolve.length, 0);
    }
  });

  it('returns 0 for help without selecting, connecting or reading', async () => {
    const result = await run({ argv: ['--help'] });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.calls.select, 0);
    assert.equal(result.calls.connect.length, 0);
    assert.equal(result.calls.candidates.length, 0);
    assert.equal(result.calls.readFile.length, 0);
  });

  it('returns 2 when the resolved database is the test database', async () => {
    const result = await run({
      argv: ['--template', `--business=${BUSINESS_ID}`],
      envConfig: { mongodbUri: 'mongodb://example.test', mongodbDbName: DATABASES.test },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /TEST database/);
    assert.equal(result.calls.connect.length, 0);
  });

  it('returns 2 when MongoDB cannot be reached', async () => {
    const result = await run({
      argv: ['--evidence=currency-review.json'],
      connect: async () => {
        throw new Error('connection refused');
      },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /could not reach MongoDB/);
    assert.equal(result.calls.resolve.length, 0);
    assert.equal(result.calls.disconnect, 0, 'a connection that never opened is not disconnected');
  });

  it('returns 2 for unreadable or invalid evidence before connecting', async () => {
    const unreadable = await run({
      argv: ['--evidence=currency-review.json'],
      readFile: () => {
        throw new Error('missing file');
      },
    });
    assert.equal(unreadable.code, 2);
    assert.match(unreadable.stderr, /could not read\/parse --evidence/);
    assert.equal(unreadable.calls.connect.length, 0);

    const invalid = await run({
      argv: ['--evidence=currency-review.json'],
      readFile: () => JSON.stringify(evidence({ reviewedBy: '', entries: [] })),
    });
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /evidence is not valid/);
    assert.equal(invalid.calls.connect.length, 0);
  });

  it('returns 2 for a production apply without the confirmation phrase', async () => {
    const previous = process.env.RESOLVE_PROD_CONFIRM;
    delete process.env.RESOLVE_PROD_CONFIRM;
    try {
      const result = await run({
        argv: ['--apply', '--with-production', '--evidence=currency-review.json'],
        selectDatabases: () => [DATABASES.production],
      });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /RESOLVE_PROD_CONFIRM=RESOLVE-PRODUCTION-CURRENCY/);
      assert.equal(result.calls.connect.length, 0);
    } finally {
      if (previous === undefined) delete process.env.RESOLVE_PROD_CONFIRM;
      else process.env.RESOLVE_PROD_CONFIRM = previous;
    }
  });

});

// The operator command's contract, without a live database.
//
// The service suite proves what an apply does. These cases prove the command
// that invokes it: dry-run is the default, `--apply` is the only way to reach a
// write, and the documented 0/1/2 exit codes stay stable when arguments, the
// target database, the connection or the report are wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, runCli } from '../scripts/recover-movement-receipts.mjs';

const DATABASES = {
  development: 'inventoryai_dev_db',
  test: 'inventoryai_test_db',
  production: 'inventoryai_prod_db',
};

function report(overrides = {}) {
  return {
    dryRun: true,
    scanned: 0,
    recovered: 0,
    flagged: 0,
    pruned: 0,
    blocked: 0,
    failed: 0,
    items: [],
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
  maintenance = async (options) => report({ dryRun: options.dryRun }),
  connect = async () => {},
  disconnect = async () => {},
  selectDatabases = () => [DATABASES.development],
} = {}) {
  const stdout = capture();
  const stderr = capture();
  const calls = { maintenance: [], connect: 0, disconnect: 0, select: 0 };
  const code = await runCli({
    argv,
    envConfig,
    databaseNames: DATABASES,
    selectDatabases: (...args) => {
      calls.select += 1;
      return selectDatabases(...args);
    },
    connect: async (...args) => {
      calls.connect += 1;
      return connect(...args);
    },
    disconnect: async () => {
      calls.disconnect += 1;
      return disconnect();
    },
    maintenance: async (options) => {
      calls.maintenance.push(options);
      return maintenance(options);
    },
    stdout,
    stderr,
  });
  return { code, calls, stdout: stdout.text(), stderr: stderr.text() };
}

describe('recover:movement-receipts CLI', () => {
  it('defaults to a dry run and never asks the maintenance service to write', async () => {
    let writes = 0;
    const result = await run({
      maintenance: async (options) => {
        if (!options.dryRun) writes += 1;
        return report({ dryRun: options.dryRun, scanned: 1, recovered: 1 });
      },
    });

    assert.equal(result.code, 1, 'a dry run that found work is exit 1');
    assert.equal(result.calls.maintenance[0].dryRun, true);
    assert.equal(writes, 0);
    assert.match(result.stdout, /\(DRY RUN\)/);
  });

  it('sends write intent only when --apply is explicit', async () => {
    const result = await run({
      argv: ['--apply'],
      maintenance: async (options) => report({ dryRun: options.dryRun }),
    });

    assert.equal(result.calls.maintenance[0].dryRun, false);
    assert.equal(result.code, 0, 'a clean apply is exit 0');
    assert.match(result.stdout, /\(APPLIED\)/);
    // Parser default and explicit apply are part of this same contract; a
    // separate parser-only test would assert nothing new.
    assert.equal(parseArgs([]).args.apply, false);
    assert.equal(parseArgs(['--apply']).args.apply, true);
  });

  it('preserves the bounds and tenant scope passed to the service', async () => {
    const businessId = '0123456789abcdef01234567';
    const result = await run({
      argv: [
        '--apply',
        '--with-production',
        '--older-than-minutes=7',
        '--retention-days=14',
        '--limit=3',
        `--business=${businessId}`,
        '--format=json',
      ],
      selectDatabases: () => [DATABASES.production],
    });

    assert.deepEqual(result.calls.maintenance[0], {
      dryRun: false,
      olderThanMs: 7 * 60_000,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      limit: 3,
      businessId,
    });
    assert.equal(JSON.parse(result.stdout).database, DATABASES.production);
    assert.equal(result.code, 0);
  });

  it('returns 0 for help without selecting a database or connecting', async () => {
    const result = await run({ argv: ['--help'] });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.calls.select, 0);
    assert.equal(result.calls.connect, 0);
    assert.equal(result.calls.maintenance.length, 0);
  });

  it('returns 2 for invalid arguments before touching a connection', async () => {
    const result = await run({ argv: ['--limit=0', '--not-a-flag'] });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /NOT CHECKED \(exit 2\)/);
    assert.equal(result.calls.connect, 0);
    assert.equal(result.calls.maintenance.length, 0);
  });

  it('returns 2 when the resolved database is the test database', async () => {
    const result = await run({
      envConfig: { mongodbUri: 'mongodb://example.test', mongodbDbName: DATABASES.test },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /TEST database/);
    assert.equal(result.calls.connect, 0);
  });

  it('returns 2 when MongoDB cannot be reached', async () => {
    const result = await run({
      connect: async () => {
        throw new Error('connection refused');
      },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /could not reach MongoDB/);
    assert.equal(result.calls.maintenance.length, 0);
    assert.equal(result.calls.disconnect, 0, 'a connection that never opened is not disconnected');
  });

  it('returns 1 when an apply leaves attention or a failure behind', async () => {
    for (const field of ['flagged', 'blocked', 'failed']) {
      const result = await run({
        argv: ['--apply'],
        maintenance: async (options) => report({ dryRun: options.dryRun, [field]: 1 }),
      });
      assert.equal(result.code, 1, `${field} must remain visible as exit 1`);
    }
  });

  it('returns 0 when a dry run or apply finds nothing to do', async () => {
    const dry = await run();
    const applied = await run({ argv: ['--apply'] });
    assert.equal(dry.code, 0);
    assert.equal(applied.code, 0);
  });

});
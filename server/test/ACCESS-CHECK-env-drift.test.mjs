// `npm run access:check` — the Render/local environment-variable NAME comparison.
//
// The check exists to catch a name that is set in one environment and not the other, which is how a
// deployment silently runs with a default (or how a local run silently needs a variable the server
// does not have). These cases pin the four outcomes — match, local-only, Render-only, both — plus the
// two properties that must never regress: a value cannot enter the comparison, and a Render refusal
// is reported without anything from the credential.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RenderAccessError,
  compareEnvNames,
  describeEnvDrift,
  fetchRenderEnvNames,
  parseEnvNames,
  pickRenderService,
} from '../../scripts/check-agent-access.mjs';

describe('access:check — env name parsing', () => {
  it('reads names only, ignoring values, comments and blank lines', () => {
    const text = [
      '# a comment',
      '',
      'MONGODB_URI=value-one-that-must-not-print',
      'AI_MODEL_OPENROUTER=openai/gpt-oss-20b',
      '  JWT_SECRET = "not-read"',
      'export EXPORTED_NAME=value',
      'QUOTED="a=b"',
    ].join('\n');
    assert.deepEqual(parseEnvNames(text), [
      'AI_MODEL_OPENROUTER',
      'EXPORTED_NAME',
      'JWT_SECRET',
      'MONGODB_URI',
      'QUOTED',
    ]);
  });

  it('does not confuse a value containing = with a second name', () => {
    assert.deepEqual(parseEnvNames('ONLY=one=two=three\n'), ['ONLY']);
  });

  it('deduplicates repeated names and tolerates empty input', () => {
    assert.deepEqual(parseEnvNames('A=1\nA=2\n'), ['A']);
    assert.deepEqual(parseEnvNames(''), []);
    assert.deepEqual(parseEnvNames(undefined), []);
  });
});

describe('access:check — env name comparison', () => {
  it('reports consistency when the two name sets are equal', () => {
    const result = compareEnvNames(['A', 'B'], ['B', 'A']);
    assert.equal(result.consistent, true);
    assert.deepEqual(result.localOnly, []);
    assert.deepEqual(result.remoteOnly, []);
    assert.equal(result.localCount, 2);
    assert.equal(result.remoteCount, 2);
  });

  it('reports names present locally but missing on Render', () => {
    const result = compareEnvNames(['A', 'B', 'LOCAL_ONLY'], ['A', 'B']);
    assert.equal(result.consistent, false);
    assert.deepEqual(result.localOnly, ['LOCAL_ONLY']);
    assert.deepEqual(result.remoteOnly, []);
  });

  it('reports names present on Render but missing locally', () => {
    const result = compareEnvNames(['A'], ['A', 'RENDER_ONLY', 'RENDER_ONLY_2']);
    assert.equal(result.consistent, false);
    assert.deepEqual(result.localOnly, []);
    assert.deepEqual(result.remoteOnly, ['RENDER_ONLY', 'RENDER_ONLY_2']);
  });

  it('reports both directions at once', () => {
    const result = compareEnvNames(['A', 'ONLY_LOCAL'], ['A', 'ONLY_RENDER']);
    assert.equal(result.consistent, false);
    assert.deepEqual(result.localOnly, ['ONLY_LOCAL']);
    assert.deepEqual(result.remoteOnly, ['ONLY_RENDER']);
    assert.equal(result.localCount, 2);
    assert.equal(result.remoteCount, 2);
  });

  it('treats an absent list as empty rather than throwing', () => {
    const result = compareEnvNames([], ['A']);
    assert.equal(result.consistent, false);
    assert.deepEqual(result.remoteOnly, ['A']);
    assert.equal(compareEnvNames(undefined, undefined).consistent, true);
  });
});

describe('access:check — Render env fetch', () => {
  const rows = [
    { envVar: { key: 'MONGODB_URI', value: 'sentinel-value-one' } },
    { envVar: { key: 'BREVO_API_KEY', value: 'sentinel-value-two' } },
    { envVar: { key: 'NO_VALUE' } },
    { envVar: { key: 42 } },
    { somethingElse: true },
  ];

  const response = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  it('returns names only and never a value', async () => {
    const names = await fetchRenderEnvNames({
      apiKey: 'fake-key',
      serviceId: 'srv-test',
      fetchImpl: async () => response(200, rows),
    });
    assert.deepEqual(names, ['BREVO_API_KEY', 'MONGODB_URI', 'NO_VALUE']);
    const serialized = JSON.stringify(names);
    assert.doesNotMatch(serialized, /sentinel-value/);
  });

  it('calls the documented endpoint with the key in a header, not the URL', async () => {
    let seen;
    await fetchRenderEnvNames({
      apiKey: 'fake-key',
      serviceId: 'srv-test',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return response(200, []);
      },
    });
    assert.equal(seen.url, 'https://api.render.com/v1/services/srv-test/env-vars?limit=100');
    assert.equal(seen.init.headers.authorization, 'Bearer fake-key');
    assert.doesNotMatch(seen.url, /fake-key/);
  });

  it('reports a refused key without echoing it', async () => {
    await assert.rejects(
      fetchRenderEnvNames({
        apiKey: 'fake-key',
        serviceId: 'srv-test',
        fetchImpl: async () => response(401, {}),
      }),
      (error) => {
        assert.ok(error instanceof RenderAccessError);
        assert.match(error.message, /refused \(401\)/);
        assert.doesNotMatch(error.message, /fake-key/);
        return true;
      },
    );
  });

  it('reports an unknown service, a server error and a malformed body safely', async () => {
    const cases = [
      [response(404, {}), /not found/],
      [response(500, {}), /answered 500/],
      [response(200, { not: 'an array' }), /unexpected body/],
    ];
    for (const [res, expected] of cases) {
      await assert.rejects(
        fetchRenderEnvNames({ apiKey: 'fake-key', serviceId: 'srv-test', fetchImpl: async () => res }),
        (error) => {
          assert.ok(error instanceof RenderAccessError);
          assert.match(error.message, expected);
          return true;
        },
      );
    }
  });

  it('refuses to call Render without a key or a service id', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return response(200, []);
    };
    await assert.rejects(fetchRenderEnvNames({ apiKey: '', serviceId: 'srv-test', fetchImpl }), RenderAccessError);
    await assert.rejects(fetchRenderEnvNames({ apiKey: 'k', serviceId: '', fetchImpl }), RenderAccessError);
    assert.equal(called, false);
  });
});

describe('access:check — Render service selection and the report line', () => {
  it('prefers the web service whose repository is this one', () => {
    const entries = [
      { service: { id: 'srv-login', type: 'web_service', name: 'login', repo: 'https://github.com/o/other' } },
      {
        service: {
          id: 'srv-api',
          type: 'web_service',
          name: 'ai-inventory',
          repo: 'https://github.com/nreffejzxc/inventory-ai',
        },
      },
    ];
    assert.deepEqual(pickRenderService(entries), { id: 'srv-api', name: 'ai-inventory' });
  });

  it('falls back to the first service when nothing matches, and returns null when empty', () => {
    assert.deepEqual(pickRenderService([{ service: { id: 'srv-1', type: 'web_service', name: 'one' } }]), {
      id: 'srv-1',
      name: 'one',
    });
    assert.equal(pickRenderService([]), null);
    assert.equal(pickRenderService(null), null);
  });

  it('describes a match with a count and a mismatch with names only', () => {
    assert.equal(
      describeEnvDrift(compareEnvNames(['A', 'B'], ['A', 'B']), 'ai-inventory'),
      '2 names match between server/.env and ai-inventory',
    );
    const drift = describeEnvDrift(
      compareEnvNames(['A', 'LOCAL_1', 'LOCAL_2'], ['A', 'RENDER_1']),
      'ai-inventory',
    );
    assert.match(drift, /local-only: LOCAL_1, LOCAL_2/);
    assert.match(drift, /Render-only: RENDER_1/);
    assert.match(drift, /3 local \/ 2 on ai-inventory/);
  });

  it('truncates a large drift so one line cannot flood the terminal', () => {
    const many = Array.from({ length: 10 }, (_, index) => `EXTRA_${index}`);
    const line = describeEnvDrift(compareEnvNames([], many), 'svc', 3);
    assert.match(line, /EXTRA_0, EXTRA_1, EXTRA_2, \+7 more/);
  });
});

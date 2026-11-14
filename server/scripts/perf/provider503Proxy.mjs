// Loopback-only provider proxy for the P3 staging 503 drill.
//
// It forwards to the real OpenRouter upstream, except that while `failing` is true it returns a
// real HTTP 503 for POST chat requests whose body names `FAIL_MODEL`. Toggle it with
// POST /__control/pass or /__control/fail. It never logs the authorization header or the prompt.
//
// Required:
//   PROVIDER_503_CONFIRM=staging-provider-503
//   FAIL_MODEL=openai/gpt-oss-20b
//   or FAIL_MODELS=model-a,model-b (for a provider-wide outage drill)
//   UPSTREAM_BASE=https://openrouter.ai
//   PORT=5055 (default)
//
// This is a test tool, not a server route. It binds 127.0.0.1 only.

import http from 'node:http';
import https from 'node:https';

const CONFIRM = 'staging-provider-503';
const PORT = Number.parseInt(process.env.PORT || '5055', 10);
const FAIL_MODELS = [...new Set(
  String(process.env.FAIL_MODELS || process.env.FAIL_MODEL || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
)];
const FAIL_MODEL = FAIL_MODELS[0] || '';
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://openrouter.ai').replace(/\/+$/, '');
let failing = true;
let failedRequests = 0;
let forwardedRequests = 0;

if (process.env.PROVIDER_503_CONFIRM !== CONFIRM) {
  console.error(`[503-proxy] set PROVIDER_503_CONFIRM=${CONFIRM}`);
  process.exit(2);
}
if (FAIL_MODELS.length === 0) {
  console.error('[503-proxy] FAIL_MODEL or FAIL_MODELS is required');
  process.exit(2);
}
if (!/^https:\/\//i.test(UPSTREAM_BASE)) {
  console.error('[503-proxy] UPSTREAM_BASE must be an https URL');
  process.exit(2);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[503-proxy] PORT must be a valid port');
  process.exit(2);
}

function sendJson(response, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

const server = http.createServer((request, response) => {
  const url = request.url || '/';

  if (url === '/__status') {
    sendJson(response, 200, {
      failing,
      failModel: FAIL_MODEL,
      failModels: FAIL_MODELS,
      failedRequests,
      forwardedRequests,
    });
    return;
  }
  if (url === '/__control/pass' || url === '/__control/fail') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST required' });
      return;
    }
    failing = url.endsWith('/fail');
    sendJson(response, 200, { failing });
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    let model = null;
    const modelBearingPath = url.includes('/chat/completions') || url.includes('/messages');
    if (modelBearingPath && body.length > 0) {
      try {
        model = JSON.parse(body.toString('utf8'))?.model ?? null;
      } catch {
        model = null;
      }
    }

    if (failing && FAIL_MODELS.includes(model) && modelBearingPath) {
      failedRequests += 1;
      console.log(`[503-proxy] fail path=${url} model=${model} count=${failedRequests}`);
      sendJson(response, 503, {
        error: {
          message: 'Upstream provider is temporarily unavailable (staging drill)',
          code: 503,
        },
      });
      return;
    }

    const upstream = new URL(`${UPSTREAM_BASE}${url}`);
    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = { ...request.headers };
    delete headers.host;
    delete headers['content-length'];
    headers['content-length'] = body.length;

    const forwarded = transport.request(
      upstream,
      {
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        forwardedRequests += 1;
        console.log(
          `[503-proxy] forward path=${url} model=${model ?? '-'} status=${upstreamResponse.statusCode}`,
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    forwarded.on('error', (error) => {
      console.error(`[503-proxy] upstream error path=${url}: ${error?.message ?? error}`);
      if (!response.headersSent) sendJson(response, 502, { error: { message: 'proxy upstream error' } });
      else response.destroy();
    });
    forwarded.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[503-proxy] listening=http://127.0.0.1:${PORT} failModels=${FAIL_MODELS.join(',')} failing=${failing}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

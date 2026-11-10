// `npm run drill:ai-failover -- --base=https://… --expect-model=openai/gpt-oss-20b` — make the
// 120B research model fail ONCE on a deployed server, and prove the 20B primary answered.
//
// WHAT IT DOES. Sends ONE research question to `POST /api/ai/chat` with
// `x-ai-failover-drill: research`. The server fails the research model once, on purpose, before
// any request reaches it, and then serves the turn through its ordinary model-failover path.
// The answer therefore comes from the fallback model, and the research model was never called.
//
// WHY IT EXISTS. A fallback that has only ever been tested against a stub is a claim, not a fact:
// the deployed configuration, its real model ids and its real answer are what a drill has to
// exercise. This asks the server itself and reports exactly what came back.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. It proves the research turn starts on the research model,
// that the model-level failover path runs, and that the fallback model really answers. It does
// NOT create a real upstream outage: the failure is synthesised inside the server, so an
// OpenRouter outage, a revoked key or a withdrawn 120B is still a separate question. The server
// log is the authority on the simulated 503 — grep for `AI failover drill:` and
// `AI failover attempt=1`.
//
// AUTH. `AI_ACCESS_TOKEN` must be an OWNER session token for the target server. The drill is
// OWNER-only by design, and the token is never printed.
//
// SAFETY. Nothing about the deployment changes: no environment variable, no restart, no model
// promotion. The drill lives for one request, and the server does not record the simulated
// failure against the research model's breaker.
//
// EXIT CODES. 0 the fallback answered, 1 the drill did not pass (wrong status or model), 2
// refused before sending (no token, or a remote base without the production confirmation).

const PROD_CONFIRM = 'ai-failover:production';

/** `--flag=value`, or undefined when absent. */
function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

/** Loopback bases are the local server, where no production confirmation is needed. */
function isLoopback(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

async function main() {
  const base = (argValue('--base') ?? 'http://localhost:4000').replace(/\/+$/, '');
  const expectModel = argValue('--expect-model') ?? 'openai/gpt-oss-20b';
  // Reviews and a comparison, so the server classifies the turn as research and starts it on the
  // research model — the only turn the drill can fire on.
  const question =
    argValue('--question') ??
    'Compare current market prices and reviews for the Sony WH-1000XM5 and tell me whether it is worth buying.';
  const token = process.env.AI_ACCESS_TOKEN;

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    console.error(`[drill] REFUSED — --base is not a URL: ${base}`);
    return 2;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(`[drill] REFUSED — --base must be http(s): ${base}`);
    return 2;
  }
  if (!token) {
    console.error('[drill] REFUSED — AI_ACCESS_TOKEN is not set (an OWNER session token is required).');
    return 2;
  }
  if (!isLoopback(base) && process.env.AI_DRILL_CONFIRM !== PROD_CONFIRM) {
    console.error(
      `[drill] REFUSED — ${base} is not loopback. Set AI_DRILL_CONFIRM=${PROD_CONFIRM} to drill it.`,
    );
    return 2;
  }

  console.log(`[drill] base     ${base}`);
  console.log(`[drill] question ${question}`);
  console.log(`[drill] expect   ${expectModel}`);

  const started = Date.now();
  let res;
  let raw;
  try {
    res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-ai-failover-drill': 'research',
      },
      body: JSON.stringify({ message: question }),
    });
    raw = await res.text();
  } catch (err) {
    console.error(`[drill] FAIL — transport error after ${Date.now() - started}ms: ${err?.message ?? err}`);
    return 1;
  }
  const ms = Date.now() - started;

  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // A non-JSON body is reported by its status alone; there is nothing to parse.
  }

  const assistant = body?.assistantMessage;
  const model = assistant?.model ?? null;
  const answer = String(assistant?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  console.log(`[drill] status   ${res.status}  ${ms} ms`);
  console.log(`[drill] model    ${model ?? '(none)'}`);
  console.log(`[drill] tools    ${(assistant?.toolsUsed ?? []).join(', ') || '(none)'}`);
  console.log(`[drill] answer   ${answer.slice(0, 400) || '(none)'}`);

  if (res.status !== 201) {
    // The refusal codes are the drill's own configuration gate, and the message is the server's
    // own explanation: print both rather than guessing at a cause.
    console.error(`[drill] FAIL — status ${res.status} code=${body?.code ?? '(none)'}`);
    if (body?.error) console.error(`[drill]        ${body.error}`);
    return 1;
  }
  if (model !== expectModel) {
    console.error(`[drill] FAIL — ${model ?? 'no model'} answered; expected ${expectModel}.`);
    console.error('[drill]        A research question answered by the research model means the drill did not fire.');
    return 1;
  }
  if (!answer) {
    console.error('[drill] FAIL — the fallback model answered an empty turn.');
    return 1;
  }

  console.log('');
  console.log(`[drill] PASS — the fallback model answered this turn (${expectModel}).`);
  console.log('[drill] Confirm the failure was SIMULATED, in the server log:');
  console.log('[drill]   AI failover drill armed: user=… research=<research model> fallback=<fallback model>');
  console.log('[drill]   AI failover drill: simulated HTTP 503 from <research model>; no provider request');
  console.log('[drill]   AI failover attempt=1 model=<research model> -> <fallback model> reason=HTTP 503 …');
  console.log('[drill]   AI turn outcome=… calls=1 … failovers=1 … model=<fallback model> …');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[drill] FAIL —', err?.message ?? err);
    process.exitCode = 1;
  });

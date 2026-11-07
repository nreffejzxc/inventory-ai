// `npm run ai:check` — is the configured AI model one the provider will actually answer with?
//
// WHY THIS EXISTS. On 2026-10-21 every assistant turn answered `502 AI_UNAVAILABLE` — "The AI
// service is temporarily unavailable. Please try again in a moment." The configured model was still
// listed by the gateway, but its upstream refused every call:
//
//   Function '<uuid>': Not found for account '<uuid>'   (HTTP 404, provider Nvidia)
//
// Nothing in the deployment asked "does this model work?" before a member did, and the turn line
// said `model=unknown` — so the one fact needed to fix it (which id to change) was missing from both
// places. This script is the cheap, repeatable answer.
//
// TWO LEVELS, because they cost different things:
//
//   npm run ai:check            reads GET /v1/models and checks the configured id is listed.
//                               NO completion is sent, so it spends no quota and is safe to run on
//                               every deploy, in CI, or after editing .env.
//
//   npm run ai:check -- --probe sends ONE tool-shaped message with the configured model. This is
//                               the check that catches an upstream that accepts the id and then
//                               refuses it — the 2026-10-21 failure — at the cost of one request
//                               from a free tier metered by requests (AI-6). Run it after changing
//                               the model, and after any provider incident.
//
// EXIT CODES — kept apart so a pipeline cannot read "could not check" as "checked and fine":
//
//   0  VERIFIED          the model is listed, and with --probe it answered
//   1  WRONG             the model is not listed, or it did not answer: change AI_MODEL_OPENROUTER
//   2  NOT VERIFIED      the provider could not be reached, or AI is not configured here — nothing
//                        was proven either way, and a 2 is never a pass
//
// It never prints the API key: the check module sends it in a header only, and every message it
// returns is a fixed sentence naming the model.

import 'dotenv/config';

import { checkModelCatalogue, probeModel } from '../src/services/ai/modelCheck.ts';
import { declaresToolSupport, refreshModelCapabilities } from '../src/services/ai/modelCapabilities.ts';
import { aiConfig, MAX_FALLBACK_MODELS } from '../src/services/ai/aiConfig.ts';
import {
  describeReasoningPolicy,
  reasoningSettings,
  resolveReasoningPolicy,
} from '../src/services/ai/reasoningPolicy.ts';

/** The candidate chain exactly as the turn loop reads it (same parse, same cap). */
function parseCandidates() {
  return aiConfig().fallbackModels.slice(0, MAX_FALLBACK_MODELS);
}

const probe = process.argv.includes('--probe');

function line(label, value) {
  console.log(`[ai:check] ${label.padEnd(10)}: ${value}`);
}

const catalogue = await checkModelCatalogue();
line('model', catalogue.model || '(unset)');
line('catalogue', `${catalogue.status} — ${catalogue.message}`);

// AI-55 — reasoning is a per-model setting, so the check prints the policy the assistant will
// actually send. A model that REQUIRES reasoning fails the probe when its policy is `off`,
// which is the failure this line exists to make visible before a member meets it.
const reasoning = reasoningSettings();
const primaryReasoning = resolveReasoningPolicy(catalogue.model, reasoning);
line(
  'reasoning',
  `${describeReasoningPolicy(primaryReasoning.policy)} — ${primaryReasoning.source === 'model' ? 'model rule' : 'default'}`,
);
if (reasoning.ignored.length > 0) {
  line('ignored', `${reasoning.ignored.length} malformed reasoning rule(s): ${reasoning.ignored.join('; ')}`);
}
if (reasoning.defaultProblem) line('warning', reasoning.defaultProblem);

if (catalogue.status === 'not_applicable') {
  // No AI in this environment is a legitimate state (the tests, a docs build), so it is NOT a
  // failure — but it is not a pass either, and the exit code says so.
  process.exit(2);
}

if (catalogue.status === 'missing') {
  console.error('[ai:check] FAILED — the configured model is not listed by the provider.');
  process.exit(1);
}

if (catalogue.status === 'unreachable') {
  console.error('[ai:check] NOT VERIFIED — the provider could not be reached; nothing was proven.');
  process.exit(2);
}

// AI-29 — the candidate chain, as the turn loop will read it.
//
// The declared-tool-support column is the free half of the check: it comes from the provider's
// catalogue, spends no request, and is what the turn loop uses to SKIP a candidate. The
// `--probe` column is the live half, because a declaration is not a demonstration — a model can
// declare `tools` and still use them badly.
const candidates = parseCandidates();
const capabilityStatus = await refreshModelCapabilities();

if (candidates.length === 0) {
  line('fallbacks', 'none configured (AI_FALLBACK_MODELS_OPENROUTER is empty)');
} else {
  line('fallbacks', `${candidates.length} candidate(s), in this order:`);
  for (const [index, id] of candidates.entries()) {
    const declared = declaresToolSupport(id);
    line(
      'candidate',
      `${index + 1}. ${id} — reasoning: ${describeReasoningPolicy(
        resolveReasoningPolicy(id, reasoning).policy,
      )}; declared tools: ${
        declared === undefined ? 'unknown (catalogue not read)' : declared ? 'yes' : 'NO (skipped at runtime)'
      }`,
    );
  }
}

if (!probe) {
  // The catalogue check is a LISTING, not a promise: on 2026-10-21 the broken model was listed. Say
  // so, so nobody reads a green line as "the assistant works".
  console.log(
    '[ai:check] the model is listed. Run with --probe to prove it answers' +
      (candidates.length > 0 ? ` (costs ${candidates.length + 1} requests: primary + each candidate).` : ' (costs one request).'),
  );
  process.exit(0);
}

const results = [];

function report(label, result) {
  results.push(result);
  line(label, `${result.status}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''} — ${result.model}`);
}

// Primary first, so the line order matches the order an operator reads them in.
report('probe', await probeModel());

if (capabilityStatus !== 'ok' && candidates.length > 0) {
  line('capability', `${capabilityStatus} — the catalogue could not be read, so tool support is unknown`);
}

let skippedForTools = 0;
for (const id of candidates) {
  if (declaresToolSupport(id) === false) {
    skippedForTools += 1;
    line('probe alt', `skipped — ${id} declares no tool support`);
    continue;
  }
  report('probe alt', await probeModel({ model: id }));
}

if (skippedForTools > 0) {
  console.error(
    `[ai:check] FAILED — ${skippedForTools} candidate(s) cannot call tools, so they are excluded from failover.`,
  );
  console.error('[ai:check] Remove them from AI_FALLBACK_MODELS_OPENROUTER or choose tool-capable models.');
  process.exit(1);
}

const unusable = results.find((result) => result.status === 'unusable');
if (unusable) {
  console.error(`[ai:check] FAILED — ${unusable.model} did not answer a tool-shaped request.`);
  console.error('[ai:check] Change AI_MODEL_OPENROUTER (or AI_FALLBACK_MODELS_OPENROUTER).');
  process.exit(1);
}

const unverified = results.find((result) => result.status !== 'usable');
if (unverified) {
  // NOT a model problem when the allowance refused it: changing the model would be the wrong
  // remedy, and the code says "nothing was proven" rather than "broken".
  console.error(
    unverified.status === 'quota'
      ? '[ai:check] NOT VERIFIED — the account allowance refused the probe; retry after the daily reset.'
      : '[ai:check] NOT VERIFIED — the probe could not run.',
  );
  process.exit(2);
}

console.log(
  results.length > 1
    ? `[ai:check] VERIFIED — all ${results.length} models answered a tool-shaped request.`
    : '[ai:check] VERIFIED — the model answered a tool-shaped request.',
);
process.exit(0);

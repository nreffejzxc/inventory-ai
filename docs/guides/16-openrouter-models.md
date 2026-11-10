# 16. Free and paid AI models through OpenRouter

The assistant can use any tool-capable model OpenRouter serves — free or paid — and you choose
it in `server/.env`. Switching between the two is a change to two values; no source change is
needed.

## 1. The three switches

| Variable | Values | What it does | Example |
| --- | --- | --- | --- |
| `AI_MODEL_OPENROUTER` | a provider/model id | The default model for ordinary inventory turns. Required; there is no default. | `openai/gpt-oss-20b` |
| `AI_RESEARCH_MODEL_OPENROUTER` | a provider/model id, optional | Research-heavy turns start here; the primary remains the default and the fallback. Unset or identical means every turn uses the primary. | `openai/gpt-oss-120b` |
| `AI_REASONING_PAID_MODELS` | `enable` or `disable` | `enable` lets a paid model use its own reasoning (required by the gpt-oss family). `disable` asks OpenRouter to turn reasoning off. | `enable` |
| `AI_REASONING_FREE_MODELS` | `enable` or `disable` | The same choice for any model id ending in `:free`, independent of `AI_REASONING_PAID_MODELS`. Unset means `disable`. | `disable` |

The connection settings are still required:

| Variable | What it does | Example |
| --- | --- | --- |
| `AI_PROVIDER` | Turns the assistant on. Leave empty to disable it. | `openrouter` |
| `OPENROUTER_BASE_URL` | OpenRouter's API base. Do not add `/v1/messages` yourself. | `https://openrouter.ai/api` |
| `OPENROUTER_API_KEY` | Your OpenRouter key. Server-side only; never in the app. | `sk-or-…` |
| `AI_FALLBACK_MODELS_OPENROUTER` | Optional comma-separated models tried, in order, when the primary is unavailable. | `nvidia/nemotron-3.5-lightning:free` |
| `AI_MAX_OUTPUT_TOKENS` | Optional answer cap (default `1200`). | `1200` |

A model id ending in `:free` costs nothing. Any other id charges your OpenRouter balance for the
tokens it uses. `AI_REASONING_PAID_MODELS` applies to paid models. A `:free` model uses
`AI_REASONING_FREE_MODELS` instead, which defaults to `disable`; it never inherits the paid
model's value.

## 2A. Free-first simple inventory

When the primary is paid and `AI_FALLBACK_MODELS_OPENROUTER` contains a tool-capable `:free` model,
five narrow questions start on that free model: one product's stock, whether a product exists, what
needs restocking, what is low, and how many products those are. The turn still calls the same
business-scoped tools, so the free model can only answer from records the paid model would read.
The free success is not promoted into the primary slot; ordinary and research turns keep their
configured routing.

The free start model follows `AI_REASONING_FREE_MODELS`, not the paid model's `AI_REASONING_PAID_MODELS`, so
the paid requirement cannot spend the free answer's budget on hidden reasoning.

The paid primary finishes the same turn only when the free attempt times out, returns an empty
completion, spends its output budget, is refused by the free daily allowance, or repeatedly drafts
an answer without the required read. There is one re-ask on the free model, then one escalation.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_SIMPLE_FREE_ATTEMPT_MS` | `15000` | The free start model's own attempt slice; `0` disables the shorter cap. |
| `AI_SIMPLE_PAID_DAILY_BUDGET_USD` | `0.25` | Process-local paid-fallback budget for the UTC day; `0` disables simple paid fallback. |
| `AI_SIMPLE_PAID_TURN_RESERVE_USD` | `0.01` | Reserved before a paid fallback call, then settled from the provider's reported charge. |

The budget is not the provider's account ledger: it resets on a server restart and is not shared
between processes. The OpenRouter dashboard remains the authority for total spend. A missing
provider charge is charged at the reservation, never treated as free. Check the turn line for
`route=simple` and `simpleEscalations`; the free model's id ends in `:free`.

## 2. Copy a working setup

**Free chain (zero cost):**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free
AI_REASONING_PAID_MODELS=disable
AI_REASONING_FREE_MODELS=disable
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free
```

**20B everyday model with 120B for research (recommended for cost):**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=openai/gpt-oss-20b
AI_RESEARCH_MODEL_OPENROUTER=openai/gpt-oss-120b
AI_REASONING_PAID_MODELS=enable
AI_REASONING_FREE_MODELS=disable
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free
```

The turn is classified once, before any request. Plain inventory questions (stock, locations,
history, recorded prices, catalogue fields) stay on the 20B model. Product/brand comparisons,
market pricing, reviews, recommendations, and explicit web research start on the 120B model. A
comparison of recorded fields — for example, "available stock versus its minimum" — is an ordinary
inventory read and stays on 20B; the words "compare" and "versus" alone do not buy a research call.
A research call that fails automatically falls back to the 20B primary, then to
`AI_FALLBACK_MODELS_OPENROUTER`; the research model is never promoted into the default slot.
This is one request per round, not a second research run, so it does not duplicate native web
searches or fetches.

**Paid primary with a free fallback:**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=openai/gpt-oss-120b
AI_REASONING_PAID_MODELS=enable
AI_REASONING_FREE_MODELS=disable
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free
```

`openai/gpt-oss-120b` and `openai/gpt-oss-20b` **require** reasoning. With
`AI_REASONING_PAID_MODELS=disable`, OpenRouter answers:

```text
invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be disabled."
```

Change `AI_REASONING_PAID_MODELS` to `enable` when a **paid** model has that requirement. A free fallback is
separate: keep `AI_REASONING_FREE_MODELS=disable` so it does not inherit the paid requirement and
spend its answer budget on hidden reasoning.

## 3. What the values send

Paid models (`AI_REASONING_PAID_MODELS`):

| Value | Request sent | Use it for |
| --- | --- | --- |
| `enable` | No reasoning field; the model uses its own default | Models that require reasoning, such as `openai/gpt-oss-*` |
| `disable` | `thinking: { type: 'disabled' }` | A paid model whose visible answer should own the output budget |

Free models (`AI_REASONING_FREE_MODELS`):

| Value | Request sent | Use it for |
| --- | --- | --- |
| `enable` | No reasoning field; the free model uses its own default | A free model that needs reasoning |
| `disable` | `thinking: { type: 'disabled' }` | The default; the visible answer owns the output budget |

`enable` is not a request to force extra thinking. It simply leaves the decision to the model,
which is what a mandatory-reasoning endpoint needs.

`AI_REASONING_FREE_MODELS=disable` is the safe choice for the free chain: on some models hidden
reasoning shares `max_tokens` with the answer, so it can consume the whole budget and return no
text.

Web Search and Web Fetch are separate, independent switches; see
[Guide 17](17-web-search-and-fetch.md).

If either reasoning setting is not exactly `enable` or `disable`, `npm run ai:check` prints the
accepted values and exits 1. Production validation fails the boot too. Aliases such as `enabled`,
`on`, `true`, `yes` and `1` are rejected.

For paid models, `AI_REASONING_PAID_MODELS` overrides the advanced per-model settings described in §7. That is
deliberate: the simple switch must not be silently defeated by an old rule. Free models always use
`AI_REASONING_FREE_MODELS`; the advanced rules do not override it.

## 3A. Read the reasoning log

Every submitted question writes one turn-level line before any provider request:

```text
[ai] free-model reasoning=disabled source=AI_REASONING_FREE_MODELS env=AI_REASONING_FREE_MODELS paid-model reasoning=enabled source=AI_REASONING_PAID_MODELS route=simple freeModel=nvidia/nemotron-3.5-lightning:free
```

Every provider request writes a line with the exact field it sent. A free request and a paid request:

```text
[ai:openrouter] free-model reasoning=disabled field=disabled source=AI_REASONING_FREE_MODELS model=nvidia/nemotron-3.5-lightning:free
[ai:openrouter] paid-model reasoning=enabled field=omitted source=AI_REASONING_PAID_MODELS model=openai/gpt-oss-20b
```

`reasoning=disabled field=disabled` is the proof that hidden reasoning was turned off.
`reasoning=enabled field=omitted` means the switch is `enable`: no reasoning field was sent, so the
model uses its own default. `field=enabled` appears only when an advanced `budget:N` rule sends an
explicit thinking budget. `source=default` means the variable is unset; free reasoning then defaults
to `disable`, while a paid model falls back to its advanced rule or the safe default. For a paid
model, `source=AI_REASONING_PAID_MODELS` means the paid switch was used; `source=model` or
`source=default` means an advanced rule or the advanced default decided it. Search Render's logs for
`free-model reasoning=` or `paid-model reasoning=`; the lines contain only configuration labels and
the model id, never a prompt or a key.

## 4. Switch models

1. Find a tool-capable id with `npm run ai:models`, or copy it from OpenRouter.
2. Edit the model line and the matching reasoning switch in `server/.env`:

   ```bash
   AI_MODEL_OPENROUTER=<new model id>
   AI_REASONING_PAID_MODELS=enable
   ```

   Use `AI_REASONING_FREE_MODELS=disable` for a free model that does not require reasoning;
   leave `AI_REASONING_PAID_MODELS` for the paid models.
3. Restart the server: stop it and run `npm start`. `.env` is read at boot.
4. Run the checks in §5.

On Render, change the same variables under **Environment**, then deploy. A saved change applies
on the **next deploy**, not on a restart.

## 5. Verify

```bash
cd server

npm run ai:check                 # is the id listed? costs nothing
npm run ai:check -- --probe      # does it answer a tool-shaped request? one request per model
npm run ai:models -- --check=openai/gpt-oss-120b   # try one id without changing .env
```

A working free setup prints:

```text
[ai:check] model      : nvidia/nemotron-3.5-lightning:free
[ai:check] catalogue  : ok — the configured model is listed: nvidia/nemotron-3.5-lightning:free
[ai:check] reasoning  : off — AI_REASONING_FREE_MODELS
[ai:check] paid reason : off — AI_REASONING_PAID_MODELS
[ai:check] free reason : off — AI_REASONING_FREE_MODELS
[ai:check] probe      : usable (HTTP 200) — nvidia/nemotron-3.5-lightning:free
[ai:check] VERIFIED — the model answered a tool-shaped request.
```

A working paid gpt-oss setup prints `reasoning : auto — AI_REASONING_PAID_MODELS` and
`paid reason : auto — AI_REASONING_PAID_MODELS`; its free fallback still prints
`free reason : off — AI_REASONING_FREE_MODELS` (or `— default` when the variable is unset).

`--probe` sends the **same reasoning setting the assistant will send**, to the primary and to
each candidate, so a model whose setting is wrong fails here rather than on a member's turn. It
costs one request per model; paid models are charged for those tokens.

Exit codes: `0` verified, `1` wrong model or invalid configuration, `2` not verified (provider
unreachable or AI not configured). A `2` is never a pass.

## 6. If it does not work

| What you see | Cause | Fix |
| --- | --- | --- |
| `Reasoning is mandatory for this endpoint and cannot be disabled` | A paid model requires reasoning but `AI_REASONING_PAID_MODELS=disable`, or a `:free` gpt-oss requires it but `AI_REASONING_FREE_MODELS=disable` | Set the matching switch to `enable` |
| `AI_REASONING_PAID_MODELS must be enable or disable` | A typo or an old mode was put in the paid switch | Use `enable` or `disable` |
| `AI_REASONING_FREE_MODELS must be enable or disable` | A typo or an alias was put in the free switch | Use `enable` or `disable` |
| `402` or `429` | No credits, or the free daily allowance is spent | Top up, or use a `:free` model and wait for the reset |
| `404` / "not listed" | Wrong model id | Copy the id from `npm run ai:models` |
| Model answers prose but never reads the inventory | The model cannot call tools | Choose a tool-capable model; `ai:check` reports declared tool support |
| Answers are empty or cut off | The output budget is too small, especially with reasoning enabled | Raise `AI_MAX_OUTPUT_TOKENS` |
| `AI_TIMEOUT` | The model is too slow for the turn deadline | Use a faster model, or raise `AI_TURN_DEADLINE_MS``AI_REASONING` is the old name for `AI_REASONING_PAID_MODELS`. It remains a deprecated fallback for one
release, read only when the new name is absent; the boot log warns and provider logs show
`source=AI_REASONING` while it is in use. The new name always wins when both are set, so rename the
old variable rather than relying on the fallback.

`AI_REASONING_PAID_MODELS` is one value for all paid models. Free models are separate, so a paid primary that
requires reasoning can keep `AI_REASONING_PAID_MODELS=enable` while `AI_REASONING_FREE_MODELS=disable` protects
the free fallback's answer budget. If paid models need different policies, use the advanced
settings in §7; those do not override the free switch.

## 7. Advanced and legacy settings

Most deployments do not need these. For paid models, when `AI_REASONING_PAID_MODELS` is set, the advanced
settings are ignored. Free models always use `AI_REASONING_FREE_MODELS`.

| Variable | What it does |
| --- | --- |
| `AI_REASONING_DEFAULT` | A paid model's reasoning when no rule matches: `off`, `auto`, or `budget:<tokens>`. |
| `AI_REASONING_MODELS_OPENROUTER` | Comma-separated `pattern=mode` rules for paid models. First match wins; `*` is a wildcard. |
| `AI_THINKING_DISABLED` | Legacy. `false` means `auto` for paid models when `AI_REASONING_DEFAULT` is unset. |
| `AI_REASONING` | Deprecated fallback for `AI_REASONING_PAID_MODELS`; replace it with the new name. |

These advanced settings do not apply to a model id ending in `:free`; the free switch above always
wins for those models.

Example for a chain that needs different policies:

```bash
AI_REASONING_DEFAULT=off
AI_REASONING_MODELS_OPENROUTER=openai/gpt-oss-*=auto,anthropic/claude-*=budget:1024
```

Leave `AI_REASONING_PAID_MODELS` unset when using that example. A `budget:` must be at least `1024` and
below `AI_MAX_OUTPUT_TOKENS`; raise the cap above the budget, for example
`AI_MAX_OUTPUT_TOKENS=4096`. A malformed rule is reported by `npm run ai:check` and is never
applied silently.

## 8. Cost and safety

- A paid model charges for every request, including rejected ones and probes. Check the price on
  the model's OpenRouter page before making it the primary.
- Keep the key in `server/.env` locally and in Render's environment in production. Never paste it
  into chat, a ticket, an issue or a screenshot.
- `AI_FALLBACK_MODELS_OPENROUTER` may contain paid ids too — a failover spends credits just like
  the primary.
- `AI_RESEARCH_MODEL_OPENROUTER` is optional and never added to the ordinary chain. If it is
  absent, invalid, or unavailable, research turns use the primary; a failed research call fails
  over to the primary rather than repeating the same research request.
- The assistant sends the same inventory tools to every model; choosing a model does not change
  what data it can read.

## 9. Drill the research failover (120B → 20B)

A fallback that has only ever been tested against a stub is a claim. The drill asks a deployed
server to fail the research model **once, on purpose**, and reports which model actually answered.

It is request-scoped: no environment variable changes, no restart, no model is promoted, and the
simulated failure is not recorded against the real research model. Other members' turns — and the
next turn — take the ordinary path.

Requirements:

- `AI_PROVIDER=openrouter` with `AI_RESEARCH_MODEL_OPENROUTER` set to a model different from
  `AI_MODEL_OPENROUTER`.
- An **OWNER** session token. A member's request is refused with `403 AI_DRILL_FORBIDDEN`.
- A research question (reviews, market prices, a comparison). Any other message is refused with
  `400 AI_DRILL_REQUIRES_RESEARCH` instead of passing as a drill that never fired.

The header is the whole interface:

```http
POST /api/ai/chat
x-ai-failover-drill: research
```

Run it against production:

```bash
cd server

AI_ACCESS_TOKEN='…' AI_DRILL_CONFIRM=ai-failover:production \
  npm run drill:ai-failover -- \
    --base=https://ai-inventory-l1mi.onrender.com \
    --expect-model=openai/gpt-oss-20b
```

`AI_DRILL_CONFIRM` is required for any non-loopback base, so a drilled request cannot be aimed at
a real server by accident. The token is never printed.

A passing run reports the answer and the model that produced it:

```text
[drill] status   201  4210 ms
[drill] model    openai/gpt-oss-20b
[drill] PASS — the fallback model answered this turn (openai/gpt-oss-20b).
```

Confirm in the server log that the failure was **simulated**, not a real outage:

```text
[ai] failover drill armed: user=… research=openai/gpt-oss-120b fallback=openai/gpt-oss-20b
[ai] failover drill: simulated HTTP 503 from openai/gpt-oss-120b; no provider request
[ai] failover attempt=1 model=openai/gpt-oss-120b -> openai/gpt-oss-20b reason=HTTP 503 remaining=…ms
[ai] turn outcome=… calls=1 … failovers=1 … model=openai/gpt-oss-20b …
```

What it proves: the research turn starts on the research model, the model-level failover path
runs, and the fallback really answers — the 20B call is a real, billed provider request. What it
does **not** prove: a genuine upstream 120B outage. The failure is synthesised inside the server
before any request is sent, so an OpenRouter outage, a revoked key or a withdrawn 120B is still a
separate question.

Exit codes: `0` the fallback answered, `1` the drill did not pass (wrong status or model), `2`
refused before sending (no token, or a remote base without `AI_DRILL_CONFIRM`).

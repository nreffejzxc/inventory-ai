# 16. Paid AI models through OpenRouter

The assistant can use any model OpenRouter serves — free or paid — and you choose it in
`server/.env`. No source change is needed to add, remove or switch a model.

This guide covers the four settings that matter, the one model setting that differs between
models (reasoning), and how to prove the model works before a member asks it a question.

## 1. The settings

| Variable | What it does | Example |
| --- | --- | --- |
| `AI_PROVIDER` | Turns the assistant on. Leave empty to disable it. | `openrouter` |
| `OPENROUTER_BASE_URL` | OpenRouter's API base. Do not add `/v1/messages` yourself. | `https://openrouter.ai/api` |
| `OPENROUTER_API_KEY` | Your OpenRouter key. Server-side only; never in the app. | `sk-or-…` |
| `AI_MODEL_OPENROUTER` | The model to use. Required; there is no default. | `openai/gpt-oss-20b` |
| `AI_FALLBACK_MODELS_OPENROUTER` | Comma-separated models tried, in order, when the primary is unavailable. Optional. | `nvidia/nemotron-3.5-lightning:free` |
| `AI_REASONING_DEFAULT` | Reasoning when no rule matches: `off`, `auto`, or `budget:<tokens>`. | `off` |
| `AI_REASONING_MODELS_OPENROUTER` | Per-model reasoning rules, comma-separated. First match wins. | `openai/gpt-oss-*=auto` |
| `AI_MAX_OUTPUT_TOKENS` | The answer's token cap (default `1200`). Must be above a `budget:`. | `1200` |
| `AI_THINKING_DISABLED` | Legacy. `false` means `auto` when `AI_REASONING_DEFAULT` is unset. Prefer the new variable. | *(leave unset)* |

A model id ending in `:free` costs nothing. Any other id charges your OpenRouter balance for the
tokens it uses.

## 2. Copy a working setup

**Free chain (zero cost):**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free,liquid/lfm-2.5-2.6b:free
AI_REASONING_DEFAULT=off
```

**Paid primary, free fallback (the `gpt-oss` family):**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=openai/gpt-oss-20b
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free
AI_REASONING_DEFAULT=off
AI_REASONING_MODELS_OPENROUTER=openai/gpt-oss-*=auto
```

`openai/gpt-oss-20b` and `openai/gpt-oss-120b` **require** reasoning. The `auto` rule is what
makes them work; without it OpenRouter answers:

```text
invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be disabled."
```

**Paid Claude primary, paid `gpt-oss` fallback:**

```bash
AI_MODEL_OPENROUTER=anthropic/claude-sonnet-4.5
AI_FALLBACK_MODELS_OPENROUTER=openai/gpt-oss-20b
AI_REASONING_DEFAULT=off
AI_REASONING_MODELS_OPENROUTER=anthropic/claude-*=budget:1024,openai/gpt-oss-*=auto
```

The rules apply to whichever model the turn is actually using, so the primary and the fallback
each get their own setting.

## 3. Reasoning

Reasoning is the model's internal thinking. It is useful, but on some models it shares the same
token budget as the visible answer, so a model can spend the whole budget thinking and return
nothing. That is why the default is `off`.

Some models refuse to turn it off. Those models need `auto` — which sends no reasoning setting at
all and lets the model use its own default.

| Mode | Request sent | Use it for |
| --- | --- | --- |
| `off` | `thinking: disabled` | Free models; saves the answer budget |
| `auto` | no reasoning field | Models that require reasoning (`openai/gpt-oss-*`) |
| `budget:N` | up to `N` reasoning tokens | A model with signed reasoning, when you want some thinking but a bounded amount |

Rules are written `pattern=mode` and separated by commas. `*` is a wildcard. **First match
wins**, so put specific models before a `*` catch-all:

```bash
AI_REASONING_DEFAULT=off
AI_REASONING_MODELS_OPENROUTER=openai/gpt-oss-*=auto,anthropic/claude-*=budget:1024,*=off
```

A `budget:` must be at least `1024` and below `AI_MAX_OUTPUT_TOKENS`; otherwise the setting is
ignored and the model uses its own default. If you use a budget, raise the cap above it, for
example `AI_MAX_OUTPUT_TOKENS=4096`.

A malformed rule is never applied silently: `npm run ai:check` prints it on an `ignored` line and
the safe default still applies.

## 4. Switch models

1. Edit `server/.env` — change `AI_MODEL_OPENROUTER` (and the fallback list if you want).
2. If the new model requires reasoning, add its rule to `AI_REASONING_MODELS_OPENROUTER`.
3. Restart the server: stop it and run `npm start`. `.env` is read at boot.
4. Run the checks in §5.

On Render, change the same variables under **Environment**, then deploy. A saved change applies
on the **next deploy**, not on a restart.

## 5. Verify

```bash
cd server

npm run ai:check                 # is the id listed? costs nothing
npm run ai:check -- --probe      # does it answer a tool-shaped request? one request per model
npm run ai:models -- --check=openai/gpt-oss-20b   # try one id without changing .env
```

A working paid setup prints:

```text
[ai:check] model      : openai/gpt-oss-20b
[ai:check] catalogue  : ok — the configured model is listed: openai/gpt-oss-20b
[ai:check] reasoning  : auto — model rule
[ai:check] probe      : usable (HTTP 200) — openai/gpt-oss-20b
[ai:check] VERIFIED — the model answered a tool-shaped request.
```

`--probe` sends the **same reasoning setting the assistant will send** (`off` or `auto`), so a
model whose rule is wrong fails here rather than on a member's turn. A `budget:` that cannot fit
the probe's 32-token cap is omitted from the probe. It costs one request per model; paid models
are charged for those tokens.

Exit codes: `0` verified, `1` wrong model or no answer, `2` not verified (provider unreachable or
AI not configured). A `2` is never a pass.

## 6. If it does not work

| What you see | Cause | Fix |
| --- | --- | --- |
| `Reasoning is mandatory for this endpoint and cannot be disabled` | The model requires reasoning but its policy is `off` | Add `openai/gpt-oss-*=auto` (or the model's own rule) |
| `402` or `429` | No credits, or the free daily allowance is spent | Top up, or use a `:free` model and wait for the reset |
| `404` / "not listed" | Wrong model id | Copy the id from `npm run ai:models` |
| Model answers prose but never reads the inventory | The model cannot call tools | Choose a tool-capable model; `ai:check` reports declared tool support |
| Answers are empty or cut off | Reasoning is spending the answer budget | Use `off`, or raise `AI_MAX_OUTPUT_TOKENS` |
| `AI_TIMEOUT` | The model is too slow for the turn deadline | Use a faster model, or raise `AI_TURN_DEADLINE_MS` |

If you are on a deployment that predates this guide and the paid model now fails with the
reasoning error, `AI_THINKING_DISABLED=false` is the temporary global escape hatch. It turns
reasoning on for **every** model, so remove it once this version is deployed.

## 7. Cost and safety

- A paid model charges for every request, including rejected ones and probes. Check the price on
  the model's OpenRouter page before making it the primary.
- Keep the key in `server/.env` locally and in Render's environment in production. Never paste it
  into chat, a ticket, an issue or a screenshot.
- `AI_FALLBACK_MODELS_OPENROUTER` may contain paid ids too — a failover spends credits just like
  the primary.
- The assistant sends the same inventory tools to every model; choosing a model does not change
  what data it can read.

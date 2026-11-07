# 16. Free and paid AI models through OpenRouter

The assistant can use any tool-capable model OpenRouter serves — free or paid — and you choose
it in `server/.env`. Switching between the two is a change to two values; no source change is
needed.

## 1. The two switches

| Variable | Values | What it does | Example |
| --- | --- | --- | --- |
| `AI_MODEL_OPENROUTER` | a provider/model id | The model that handles the turn. Required; there is no default. | `openai/gpt-oss-120b` |
| `AI_REASONING` | `enable` or `disable` | `enable` lets the model use its own reasoning (required by the gpt-oss family). `disable` asks OpenRouter to turn reasoning off. | `enable` |

The connection settings are still required:

| Variable | What it does | Example |
| --- | --- | --- |
| `AI_PROVIDER` | Turns the assistant on. Leave empty to disable it. | `openrouter` |
| `OPENROUTER_BASE_URL` | OpenRouter's API base. Do not add `/v1/messages` yourself. | `https://openrouter.ai/api` |
| `OPENROUTER_API_KEY` | Your OpenRouter key. Server-side only; never in the app. | `sk-or-…` |
| `AI_FALLBACK_MODELS_OPENROUTER` | Optional comma-separated models tried, in order, when the primary is unavailable. | `nvidia/nemotron-3.5-lightning:free` |
| `AI_MAX_OUTPUT_TOKENS` | Optional answer cap (default `1200`). | `1200` |

A model id ending in `:free` costs nothing. Any other id charges your OpenRouter balance for the
tokens it uses. `AI_REASONING` applies to the primary and to every failover model in the chain.

## 2. Copy a working setup

**Free chain (zero cost):**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=nvidia/nemotron-3.5-lightning:free
AI_REASONING=disable
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free
```

**Paid primary with a free fallback:**

```bash
AI_PROVIDER=openrouter
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_API_KEY=replace-with-your-key
AI_MODEL_OPENROUTER=openai/gpt-oss-120b
AI_REASONING=enable
AI_FALLBACK_MODELS_OPENROUTER=nvidia/nemotron-3.5-lightning:free
```

`openai/gpt-oss-120b` and `openai/gpt-oss-20b` **require** reasoning. With
`AI_REASONING=disable`, OpenRouter answers:

```text
invalid_request_error: "Reasoning is mandatory for this endpoint and cannot be disabled."
```

Change the switch to `enable` when the primary or any fallback model has that requirement. One
value covers the whole chain, so you do not need a separate rule for each model.

## 3. What the two values send

| `AI_REASONING` | Request sent | Use it for |
| --- | --- | --- |
| `enable` | No reasoning field; the model uses its own default | Models that require reasoning, such as `openai/gpt-oss-*` |
| `disable` | `thinking: { type: 'disabled' }` | Free models; the visible answer owns the output budget |

`enable` is not a request to force extra thinking. It simply leaves the decision to the model,
which is what a mandatory-reasoning endpoint needs.

`disable` is the safe choice for the free chain: on some models hidden reasoning shares
`max_tokens` with the answer, so it can consume the whole budget and return no text.

If the setting is not `enable` or `disable`, `npm run ai:check` prints the accepted values and
exits 1. The assistant keeps a safe fallback for the turn, but the typo must be fixed.

`AI_REASONING` overrides the advanced per-model settings described in §7. That is deliberate: the
simple switch must not be silently defeated by an old rule.

## 4. Switch models

1. Find a tool-capable id with `npm run ai:models`, or copy it from OpenRouter.
2. Edit these two lines in `server/.env`:

   ```bash
   AI_MODEL_OPENROUTER=<new model id>
   AI_REASONING=enable
   ```

   Use `AI_REASONING=disable` instead when the new model is a free model that does not
   require reasoning.
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
[ai:check] reasoning  : off — AI_REASONING
[ai:check] probe      : usable (HTTP 200) — nvidia/nemotron-3.5-lightning:free
[ai:check] VERIFIED — the model answered a tool-shaped request.
```

A working paid gpt-oss setup prints the same lines with `reasoning : auto — AI_REASONING`.

`--probe` sends the **same reasoning setting the assistant will send**, to the primary and to
each candidate, so a model whose setting is wrong fails here rather than on a member's turn. It
costs one request per model; paid models are charged for those tokens.

Exit codes: `0` verified, `1` wrong model or invalid configuration, `2` not verified (provider
unreachable or AI not configured). A `2` is never a pass.

## 6. If it does not work

| What you see | Cause | Fix |
| --- | --- | --- |
| `Reasoning is mandatory for this endpoint and cannot be disabled` | The model requires reasoning but `AI_REASONING=disable` | Set `AI_REASONING=enable` |
| `AI_REASONING must be enable or disable` | A typo or an old mode was put in the switch | Use `enable` or `disable` |
| `402` or `429` | No credits, or the free daily allowance is spent | Top up, or use a `:free` model and wait for the reset |
| `404` / "not listed" | Wrong model id | Copy the id from `npm run ai:models` |
| Model answers prose but never reads the inventory | The model cannot call tools | Choose a tool-capable model; `ai:check` reports declared tool support |
| Answers are empty or cut off | The output budget is too small, especially with reasoning enabled | Raise `AI_MAX_OUTPUT_TOKENS` |
| `AI_TIMEOUT` | The model is too slow for the turn deadline | Use a faster model, or raise `AI_TURN_DEADLINE_MS` |

If the primary and a fallback have different requirements, remember that `AI_REASONING` is one
value for the whole chain. Set `enable` if **any** model in the chain requires it. If you truly
need different policies per model, use the advanced settings in §7 instead of `AI_REASONING`.

## 7. Advanced and legacy settings

Most deployments do not need these. When `AI_REASONING` is set, the advanced settings are
ignored.

| Variable | What it does |
| --- | --- |
| `AI_REASONING_DEFAULT` | Reasoning when no rule matches: `off`, `auto`, or `budget:<tokens>`. |
| `AI_REASONING_MODELS_OPENROUTER` | Comma-separated `pattern=mode` rules. First match wins; `*` is a wildcard. |
| `AI_THINKING_DISABLED` | Legacy. `false` means `auto` when `AI_REASONING_DEFAULT` is unset. |

Example for a chain that needs different policies:

```bash
AI_REASONING_DEFAULT=off
AI_REASONING_MODELS_OPENROUTER=openai/gpt-oss-*=auto,anthropic/claude-*=budget:1024
```

Leave `AI_REASONING` unset when using that example. A `budget:` must be at least `1024` and
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
- The assistant sends the same inventory tools to every model; choosing a model does not change
  what data it can read.

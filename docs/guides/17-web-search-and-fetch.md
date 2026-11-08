# 17. Web Search and Web Fetch

OpenRouter can give the assistant two built-in web tools. They are independent, **off by
default**, and can add provider charges on top of the model call.

When **both** switches are `enable` on an OpenRouter deployment, these native tools are the
assistant's **primary** research path. The local `researchInventoryProducts` and
`researchMarketPrices` tools are withheld, so the assistant uses OpenRouter's own search and
fetch instead of the slower custom path. If either switch is off, the native path is not
complete and the local research tools remain available.

| Variable | `enable` | `disable` |
| --- | --- | --- |
| `AI_WEB_SEARCH` | The assistant may search the web for current information. | The search tool is not sent. |
| `AI_WEB_FETCH` | The assistant may fetch a URL and read its page or PDF content. | The fetch tool is not sent. |

Set each variable to `enable` or `disable`. The fallback chain uses the same two
settings; changing the model does not change them. `AI_REASONING` is separate and still
applies per model.

Research-heavy turns can also start on a stronger model through
[`AI_RESEARCH_MODEL_OPENROUTER`](16-openrouter-models.md): ordinary inventory questions stay
on the smaller default, while comparisons, reviews, market pricing and explicit research use
the research model. Both models receive the same native web tools. If the research model
fails, the turn falls back to the standard model rather than issuing a second research
request.

These switches control OpenRouter's built-in server tools. The local
`researchInventoryProducts` and `researchMarketPrices` tools have their own
`AI_ALLOW_PAID_WEB_SEARCH` gate and keyless search fallback. They are used only when the
native path is unavailable; with both switches on they are not offered at all.
`AI_WEB_SEARCH_URL` is also separate: it is the keyless research endpoint, not this switch.

## When the tools are offered

Enabling a switch does **not** mean every question uses it. OpenRouter's server tools are
model-invoked: the model receives the tool, decides whether the request needs it, and may
call it zero or more times. The final answer round receives no tools at all.

Our turn loop adds a conservative gate before that decision. The paid tools are offered
only when the member's message clearly asks for public-web research, such as reviews,
quality/reliability, online or marketplace prices, current product news, explicit web
search/fetch, or a URL. Plain inventory questions — stock levels, locations, movements,
catalogue fields, recorded selling prices, simple specifications, and “review my stock” —
keep the paid tools out of the request entirely. The model still chooses whether to use
an offered tool.

If a borderline research question is not recognised, the paid tools stay out of the
request and the member can make the request explicit ("search the web for…"). This is
intentionally conservative: missing a paid opportunity is preferable to billing a simple
inventory question.

## Native-first and fallback

With both switches on, the turn loop follows this order:

1. It withholds `researchInventoryProducts` and `researchMarketPrices` and sends
   `openrouter:web_search` and `openrouter:web_fetch` beside the inventory tools.
2. A native search or fetch reported in the response content or usage counts as a real
   research read, so the turn does not re-ask for a local tool and pay twice.
3. If a research answer arrives with no native read, the turn re-asks once for the native
   tools. If the next answer still has no native read, that turn switches to the local
   research tools.
4. If OpenRouter refuses the native tools with HTTP 400 or 403, the turn retries once with
   the local research tools and no native tool definitions.

With either switch off, rule 39 is not added and the local research tools stay available.
The same choice travels with every fallback model in the chain.

## Cost controls

OpenRouter's default `auto` search uses Exa when the model has no native search. Current
OpenRouter pricing is about **$0.007 per search** and **$0.001 per fetched page** through
Exa, plus normal model tokens. Native provider tools are passed through at the provider's
prices. See the [search pricing](https://openrouter.ai/docs/guides/features/server-tools/web-search#pricing)
and [fetch pricing](https://openrouter.ai/docs/guides/features/server-tools/web-fetch#pricing).

Each request is hard-capped:

| Tool | Per-request cap |
| --- | --- |
| Web Search | 2 searches, at most 10 total results |
| Web Fetch | 2 pages, at most 30,000 content tokens |

The cap is per OpenRouter request, not per assistant turn. The intent gate and the
tool-free answer round keep the turn bounded; the `used` field in the logs shows actual
activity. When the native tools are primary, the local `researchInventoryProducts` and
`researchMarketPrices` paths are fallback only; with either switch off they remain the
research path.

## Copy a setup

Both tools on (native primary):

```bash
AI_WEB_SEARCH=enable
AI_WEB_FETCH=enable
```

Search only:

```bash
AI_WEB_SEARCH=enable
AI_WEB_FETCH=disable
```

Fetch only:

```bash
AI_WEB_SEARCH=disable
AI_WEB_FETCH=enable
```

Both off (the default):

```bash
AI_WEB_SEARCH=disable
AI_WEB_FETCH=disable
```

## Apply and verify

1. Put the two lines in `server/.env`.
2. Restart the server so it reads the file again.
3. Run:

   ```bash
   cd server
   npm run ai:check
   ```

   The output includes the effective state, for example:

   ```text
   [ai:check] web tools : search enabled, fetch disabled
   ```

4. Open the assistant and try the capability:

   - Search: **“Search the web for the latest version of this product and cite the sources.”**
   - Fetch: **“Fetch https://example.com and summarize the page.”**

   A successful turn returns current search results or the fetched page's content. With
   both switches on, the turn log should show `web=search` and/or `web=fetch`, and the
   request log should show `used=search` and/or `used=fetch`. If the tool is disabled, it
   is not sent to OpenRouter, so the assistant cannot use that capability on the turn.

An invalid value makes `npm run ai:check` exit 1 and name the variable. The server also
keeps the tool disabled and logs a warning at boot; it never turns a paid tool on because
of a typo.

## Read the logs

When either switch is on, every OpenRouter request writes one line to the server log:

```text
[ai:openrouter] web tools enabled=search,fetch offered=search,fetch used=search intent=web model=openai/gpt-oss-20b
```

- `enabled` is the `.env` configuration.
- `offered` says whether that request actually carried the tool. `offered=none` means the
  intent gate withheld it, or this was the final answer round.
- `used` is the provider's actual server-tool activity. `used=none` means the tool was
  enabled but the model did not use it on that request.
- `intent=web` means the question passed the external-research gate; `intent=inventory`
  means the paid tools were deliberately withheld.

The turn-level line also carries `web=search`, `web=fetch`, `web=search,fetch` or `web=none`,
which is the provider-reported native activity for the whole turn.

It carries the provider's own charge as `cost=$0.007192` (USD, summed across every model
call in the turn). `cost=unknown` means no response reported a charge, and a leading `>=`
means some responses reported one while others did not, so the number is a lower bound. A
reported zero is printed as `$0.000000`; it is not the same as an omission.

A simple inventory request therefore logs this, without making a search or fetch:

```text
[ai:openrouter] web tools enabled=search,fetch offered=none used=none intent=inventory model=openai/gpt-oss-20b
```

Search Render's service logs for `[ai:openrouter] web tools`. The same line works for free
and paid models; the `model=` field identifies which one handled the request. It contains
only capability labels and the model id: no prompt, search query, URL, page content or API
key is written. Each provider request has its own line, so a turn that uses tools and then
answers can show both `used=...` and `used=none`.

`AI_WEB_SEARCH` and `AI_WEB_FETCH` are optional. Leave either one out to use its default,
which is `disable`.

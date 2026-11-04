# AI-47 — Research the web, recommend only what we stock

## What shipped

`researchInventoryProducts` is the assistant's **16th read-only tool**. It accepts up to eight
product IDs from the session's own business, refuses missing, archived or cross-tenant IDs before
any search, and loads the recorded name, brand, category and selling price itself. The model cannot
send a free-text brand or an outside product into the query.

Research runs on the existing OpenRouter key with its web plugin, grouped by recorded brand and
bounded to six brand groups, eight findings and eight sources. A finding is kept only when it maps
back to one of the exact recorded subjects; an answer with findings but no valid public citation is
treated as unavailable, not as evidence. The final prompt may recommend only names from the
inventory, must keep recorded stock/price facts separate from web findings, and must say when a
finding is only a search-result snippet.

When the free research model is refused or returns no usable finding, the server falls back to
DuckDuckGo's HTML result page for that brand. This is keyless and returns only a title, a short
snippet and a public URL; it does not fetch the result page, so an outside brand cannot be imported
through page prose. `AI_WEB_SEARCH_URL` selects that endpoint.

The final answer now appends every source URL the model omitted, once. A model that names a
publication without linking it no longer leaves an unverifiable claim: the server adds a
`Source URLs:` list after the answer and streams the same appended text to a streaming client. A
no-result fallback query is retried once with the recorded brand alone, which covers a long product
name such as *Royal Kludge RK61 Plus* missing a small brand on the first query.

The mobile provenance label is **Web research**, and the release note
`2026-11-03-web-research` announces the feature in the app.

## Server verification

- `server/test/AI47-inventory-web-research.test.mjs` — **11 unit + 3 DB** pass.
  The unit half sends only recorded names, searches each brand separately, rejects an answer with
  no valid citation, parses only public result links, keeps snippets, appends a missing URL once,
  and pins the prompt and read-only tool boundary. The DB half proves cross-tenant, archived and
  malformed IDs are refused before the web is called.
- `npm run typecheck` and `npm run lint` are clean.
- PR **#145** merged as **`0278c28`**, PR **#146** as **`178cbe6`**, and PR **#147** as
  **`f0eefb5`**. All four required checks were green on each; the last run is
  [41730904633](https://github.com/nreffejzxc/inventory-ai/actions/runs/41730904633).
- Production `/api/health` reports `f0eefb5`, database `connected`, **0** server errors.

## The live test found two defects

Preview OTA `1ac39b80-1b9b-44cc-86d7-2cea4ba80bf5` (update
`01a1a37d-7a5b-7f6d-a457-02673b8fdb5b`, runtime `1.0.1`, commit `178cbe6`) was published to the
installed preview build. In a new chat the phone was asked:

> Research reliable brands for our keyboards and peripherals

The answer stayed within the three recorded brands and their inventory products. It reported ROG
durability/quality-control evidence, a RAK Gears signal about possible quality problems, and said
Royal Kludge had no available evidence in the session. It also said it could recommend only what
the business actually carries.

But it failed the reviewability requirement: the answer named *ROG Product Guide* and *ASUS ROG
Strix Flare II review* without their URLs, and Royal Kludge had no source at all. The installed
bundle also still showed the old humanised label **Research inventory products**, because the OTA
had been downloaded but not applied by a second launch. PR #147 fixes the missing URLs and the
empty-brand retry; the label is already in the published bundle.

Screenshots: [`question.png`](question.png), [`answer-top.png`](answer-top.png),
[`answer-bottom.png`](answer-bottom.png).

## Final phone check — blocked

The follow-up device pass could not be run. On 2026-11-04 `adb devices` was empty, Windows
enumerated no Android USB device, and ADB's mDNS list was empty; restarting the ADB server did not
bring the phone back. A server-only change cannot be applied to the phone, but the URL appending is
deterministic and covered by the new unit test. **No claim is made that the link list or the Web
research label was observed on the device after the fix.** The last device evidence remains the
`178cbe6` run above.

To finish the device check: reconnect the phone, launch the app twice so OTA `1ac39b80` applies,
confirm the provenance chip reads **Web research**, ask the same question in a new chat, and verify
that each brand with evidence carries a `Source URLs:` link. The phone must be online; the research
fallback itself needs no second API key.

## What this does not prove

The OpenRouter account is free-tier and the default research model's daily allowance was exhausted
during the live test; the observed answer came from the DuckDuckGo fallback. That fallback gives
search-result snippets, not full reviews, and can be rate-limited or change its markup. A source is
evidence for a claim, not proof that a product is reliable, and web findings are never inventory
records. This tenant has only three recorded brands and no specification/rating field, so the phone
cannot demonstrate a broad brand comparison from its own data.

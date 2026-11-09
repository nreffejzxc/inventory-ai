# 20-question phone matrix on the 10k tenant (2026-11-09)

This report records the production Android app against the 10,000-product performance tenant. The
matrix ran in **one conversation** (`6af22ae9df2d0cea08b4d596`); it did not open a fresh chat per
question. T6 needed one retry in that same conversation after the first answer repeated T5. A wrong
tap later opened the Restock search screen; E5 and E6 were recovered into the same conversation.
There were 21 model attempts for the 20 final questions.

## Run

| Field | Value |
| --- | --- |
| Device | `CPH1969` at `192.168.1.2:5555` |
| App | `1.0.2`, versionCode 10 |
| OTA | `0e4eca55-0e4f-47fc-b2d6-507f91b529b8` (newest production group) |
| Tenant | `PERF SEED — AI assistant stress test (do not use)` (`6af18628a9a409131a84235b`) |
| Tenant facts | 10,000 products; 2,446,801 units; 1,535 low; 632 out; 13 categories; 37 brands |
| Conversation | `6af22ae9df2d0cea08b4d596` |
| Models | 18 answers on `openai/gpt-oss-20b`; B7 and T7 on `openai/gpt-oss-120b` |
| Cost | **$0.043875745** paid usage (`1.202738017 → 1.246613762`) |
| Free quota | **0/1000** before and after; every answer was paid |
| Latency | Server turn median **6.35 s**, p95 **14.61 s** (stored user message → stored assistant answer). The 18 clean phone end-to-end samples had median **15.48 s**, p95 **24.83 s**; E3/E4 end-to-end was not cleanly captured. |

## What's New

The installed app displayed the new card on the dashboard:

> **What's new**
> **Clearer stock totals and restock counts**
> Simple stock questions now read your inventory first and answer with the combined quantity, not a
> guess or a partial page.
> **Got it** · **See what's new**

The dashboard also showed **8,465 in stock**, **1,535 low**, **632 out**, **10,000 active products**
and **2,446,801 total on-hand quantity**. EAS `update:list` names `0e4eca55` as the newest production
group, and the app's update check reported `isUpdateAvailable=false`. The card is therefore observed
on the installed 1.0.2 app, not merely in the published manifest.

See [`whats-new.png`](whats-new.png) and [`whats-new-ui.txt`](whats-new-ui.txt).

## Results

| # | ID | Language | Verdict | Evidence |
|---|----|----------|---------|----------|
| 1 | B1 | Bisaya | PASS | 10,000 active products; 2,446,801 units |
| 2 | B2 | Bisaya | PARTIAL | 1,535 low; 632 out — correct, but answered in Tagalog |
| 3 | B3 | Bisaya | PASS | Logitech MX Master 3S, SEEDSKU-5; Main Warehouse 34 |
| 4 | B4 | Bisaya | PASS | Logitech MX Keys S, SEEDSKU-0; 6,290; Shop Front 201 + Main 200 |
| 5 | B5 | Bisaya | PASS | Keyboards & Mice: 1,308 products; 320,250 units |
| 6 | B6 | Bisaya | PASS | Automotive & Car Care: 1,736 products |
| 7 | B7 | Bisaya | FAIL | Sources and prices given with only `findProducts`; no web-search/fetch tool recorded |
| 8 | T1 | Tagalog | PASS | 10,000 active products; 2,446,801 units |
| 9 | T2 | Tagalog | PASS | 1,535 low; 632 out |
| 10 | T3 | Tagalog | PASS | SEEDSKU-0: 6,290; 401 total (Shop Front 201, Main 200) |
| 11 | T4 | Tagalog | PASS | Keyboards & Mice value: 2,444,247,590 |
| 12 | T5 | Tagalog | PASS | SEEDSKU-5 5,490 / 34; SEEDSKU-51 5,490 / 182 |
| 13 | T6 | Tagalog | PARTIAL | Retry: Royal Kludge RK61, 2,499, 15 total; only 7 at Main, but answer said all 15 |
| 14 | T7 | Tagalog | FAIL | US retailer prices and URLs given with only `findProducts`; sources unverified |
| 15 | E1 | English | PARTIAL | 37 brands and three names correct; answered in Tagalog |
| 16 | E2 | English | PASS | Main Warehouse: 10,000 products; 1,490,818 units |
| 17 | E3 | English | PASS | 1,535 restocking; three genuine out-of-stock names |
| 18 | E4 | English | PASS | Samsung Bespoke RF29BB8600QL, SEEDSKU-344, 152,181,990 |
| 19 | E5 | English | PASS | Five latest movements match the database |
| 20 | E6 | English | PASS | LG InstaView Door-in-Door LRFXS2503S, SEEDSKU-1495, 527 units out |

**Verdict: 15 PASS, 3 PARTIAL, 2 FAIL.**

## Findings

### Research grounding is still not demonstrated (B7, T7)

Both research questions used `openai/gpt-oss-120b` and recorded only `findProducts` in `toolsUsed`.
Neither message records a web-search or web-fetch tool. The answers contain plausible store names,
prices and URLs, but nothing in the stored turn shows those pages were read. This is the same trust
failure as the 2026-11-08 matrix, where B7 and T7 also cited sources without a research tool. The
sources may be real; the turn does not prove it, so these are not passing answers.

### Language drift (B2, E1)

B2 was asked in Bisaya and answered in Tagalog. E1 was asked in English and answered in Tagalog.
Both answers were factually correct; the verdict is PARTIAL for the language requirement, not for
the inventory data.

### T6 context and stock location

The first T6 attempt repeated the T5 comparison instead of recommending a product. A clarified retry
in the same conversation found a real **Royal Kludge RK61** at **2,499** with **15 total units**, but
said all 15 were at Main Warehouse; the database has **7 at Main** and the other 8 elsewhere. The
product and price are valid; the stock location is wrong, so the retry is PARTIAL.

### Harness recovery

The first raw runner state (`matrix-raw.json`) contains E3 and E4 rows captured one turn late. The
stored message pairs show the actual E3 and E4 answers and both are correct; the table above uses the
stored sequence, not those two stale rows. A later tap opened Restock search instead of the chat;
E5 and E6 were recovered into the same conversation and are in `retry-raw.json`. The conversation
was not replaced.

## What is not proved

- **No free-served answer.** A separate live simple turn selected
  `nvidia/nemotron-3.5-lightning:free` first, but OpenRouter refused it with `quota=0/1000` and the
  server fell forward once to `openai/gpt-oss-20b`, which answered the 34-unit question correctly.
  The free-first route was exercised; the free model itself served no answer before the reset at
  `2026-11-10T00:00:00Z` (08:00 PHT).
- **No production inventory changes.** The run only read through the assistant; it wrote no product,
  stock, location or movement records. The 10k tenant is the disposable performance tenant.
- **No deploy.** This report is documentation only. The phone matrix used the already-deployed
  `5b05307` production runtime.

## Artifacts

- [`matrix-raw.json`](matrix-raw.json) — first-pass runner state, including the stale E3/E4 rows.
- [`retry-raw.json`](retry-raw.json) — T6 retry plus E5 and E6.
- [`tenant-facts.json`](tenant-facts.json) — the read-only 10k tenant facts used for verdicts.
- [`whats-new.png`](whats-new.png) — dashboard card on the installed app.
- [`whats-new-ui.txt`](whats-new-ui.txt) — UI hierarchy from the same dashboard.

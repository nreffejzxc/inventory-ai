# Task 4 — installed Android app: `Ref:` line, What's New card, and live language turns (2026-11-11)

This report records the production Android app (`com.inventoryai.app`, versionName `1.0.2`,
versionCode `10`) on the OPPO `CPH1969`, Android 11, ADB serial `PV4DDMIZZLTCIVSK`. The signed-in
tenant was **joffy steelseries / Owner** (`jaffyfreebuff6183@gmail.com`; 113 active products,
26,974 units on hand). No tenant data, product record or server configuration was changed.

## `Ref:` line — observed after the production OTA bundle was restored

The first observation (**`Ref: 74ef2707`**, with `Read: Stock movements` and the truncation notice)
came from the production OTA bundle. Clearing only the app's local data left the app on its
embedded Nov 9 bundle, which predates the ref feature, so a fresh answer showed no ref. A
force-stop/relaunch let the production OTA update download and apply, and the dashboard then showed
the OTA **What's new — AI answers now include a support reference** card. After **Got it**, a fresh
answer rendered:

- the answer text,
- **`Read: Inventory summary · Stock value`**, and
- **`Ref: 566f6d71`** (selectable, under the answer, above the timestamp).

The later live language turns rendered **`Ref: 9adeefa7`** (Tagalog) and **`Ref: 0d1ed88c`**
(Bisaya). See [`ref-line-ota.png`](ref-line-ota.png) and the language screenshots below.

## What's New card — observed

The embedded bundle's card (**“More accurate totals and more grounded answers”**) was observed
first; after the OTA bundle applied, the dashboard showed the newer
**“AI answers now include a support reference”** card:

> **What's new**
> **AI answers now include a support reference**
> Each assistant answer shows a short reference you can copy, so support can find the exact answer
> if you ask for help.
> **Got it** · **See what's new**

Tapping **Got it** removed the card immediately. See
[`whats-new-card.png`](whats-new-card.png) for the earlier card; the OTA card's text is recorded in
the UI transcript above.

## Live language turns

All three turns ran against the deployed server, not a local build.

| Language | Question | Answer | Reference |
| --- | --- | --- | --- |
| Bisaya | `Pila ka units ang naa sa stock?` | **“26,974 ka units ang naa sa pag-imbentaryo sa tanan nga lokasyon.”** | — |
| Tagalog (before the fix) | `Ilan ang low stock na produkto?` | English low-stock list (the defect this task recorded) | — |
| Tagalog (after the fix) | `Ilan ang low stock na produkto?` | **“May 19 na produktong mababa ang stock.”** | `9adeefa7` |
| Bisaya (after the fix) | `Pila ka low stock nga butang?` | **“Adunay 19 ka produkto nga ubos ang stock.”** | `0d1ed88c` |

The 19 is independently confirmed by the Restock screen:
**“19 products at or below minimum stock, most urgent first.”** See
[`tagalog-answer.png`](tagalog-answer.png) for the pre-fix English answer,
[`tagalog-count-after-fix.png`](tagalog-count-after-fix.png),
[`bisaya-count-after-fix.png`](bisaya-count-after-fix.png), and
[`restock-count-19.png`](restock-count-19.png).

## Streaming reset — observed and fixed

A live Tagalog count turn showed the reported sequence: a draft appeared, the bubble fell back to
**“Analyzing your inventory…”**, then the final **“May 19 na produktong mababa ang stock.”** The
final answer was the server's stored deterministic count (19, matching the Restock screen), not a
truncation. The reset is AI-74: the server invalidated a draft and replayed the stored answer. The
client now labels the wait **“Correcting the answer…”** and says the earlier draft was replaced.
The installed app needs the next OTA to show this label; the focused Jest AI-40 suite passes 11/11.

## Limits

- Only Android was tested; iOS remains an external verification item.
- The screenshots contain the tenant's business name and aggregate stock figures, which are already
  visible on the signed-in dashboard; no credential, token or personal data is included.- The output-limit retry (AI-105) is verified at unit and real-wire level; the live occurrence is intermittent and was not reproduced in this session.

## 2026-11-11 follow-up — the reset-label OTA

The next production OTA (group `58f75323-eeab-4aee-b48d-5f3c38e2396a`, runtime `1.0.2`) was
published and loaded on the same phone, but the **“Correcting the answer…”** label was not observed
live: the phone turns took the ordinary tool-read route rather than the server reset/re-ask path.
See [`../ai106-ota-2026-11-11/README.md`](../ai106-ota-2026-11-11/README.md) for the OTA details,
the count/value audit finding, and the exact references. This addendum does not rewrite the earlier
observation; it records that the label remains unverified. The server-side AI-106 fix was later
deployed as `26eb0d4`; its production count and compound turns are in
[`../ai106-production-2026-11-11/README.md`](../ai106-production-2026-11-11/README.md).

# Task 4 — installed Android app: `Ref:` line and What's New card (2026-11-11)

This report records the production Android app (`com.inventoryai.app`, versionName `1.0.2`,
versionCode `10`) on the OPPO `CPH1969`, Android 11, ADB serial `PV4DDMIZZLTCIVSK`. The signed-in
tenant was **joffy steelseries / Owner** (`jaffyfreebuff6183@gmail.com`; 113 active products,
26,974 units on hand). No tenant data, product record or server configuration was changed.

## `Ref:` line — observed

The newest stored AI answer, opened from the AI Assistant conversation list, rendered:

- the answer text and its truncation notice,
- **`Read: Stock movements`**, and
- **`Ref: 74ef2707`** (selectable, under the answer, above the timestamp).

The line is not clipped or overlapped by the answer card, and the `Ref:` label is legible. See
[`ref-line.png`](ref-line.png).

## What's New card — observed on a fresh install

The app's local data was cleared through the phone's own **Settings → Apps → Inventory AI →
Storage → Clear data** confirmation (the shell `pm clear` command is refused by this OPPO build),
then the app was signed back in with the existing Google account. On first launch after sign-in,
the dashboard rendered the newest release note:

> **What's new**
> **More accurate totals and more grounded answers**
> The assistant now keeps a stock-value total together with the highest-value item, stays on the
> everyday model for stock comparisons, and avoids unsupported sales claims.
> **Got it** · **See what's new**

The card's title wraps to two lines without clipping, the summary is fully visible, both controls
have their own tap rows, and the card sits below the greeting and above the **Overview** section.
Tapping **Got it** removed the card immediately; a fresh UI dump then contained no `What's new`,
`Got it`, or note title. See [`whats-new-card.png`](whats-new-card.png).

## Limits

- Only Android was tested; iOS remains an external verification item.
- The screenshots contain the tenant's business name and aggregate stock figures, which are already
  visible on the signed-in dashboard; no credential, token or personal data is included.
- The card test used a fresh local app state. It does not re-verify an over-the-air update
  application; the installed bundle is the current production 1.0.2 build.

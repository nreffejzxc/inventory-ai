# AI-115 / AI-116 production device evidence — 2026-11-16

**Target.** Render production `https://ai-inventory-l1mi.onrender.com`; `/api/health` reported
`status: ok`, `db: connected`, `environment: production` and commit
`9f81e34cb99f8f329b138d6687b510f520a67c81`.

**Build.** OPPO CPH1969, installed `com.inventoryai.app` version `1.0.2` (versionCode 10), runtime
`1.0.2`. EAS production OTA
[`06d16237-ee08-4c41-9419-b4760f54a918`](https://expo.dev/accounts/jeffernqwes-team/projects/inventory-ai/updates/06d16237-ee08-4c41-9419-b4760f54a918)
published the mobile UI from commit `396c3f7`. No native build was made.

## Checks

| Check | Observed | Evidence |
| --- | --- | --- |
| Freshness line on a fresh answer | `Inventory records · 19 products`, time, Inspect | `03-answer-footer.png` |
| Inspect detail | Retrieved, `Sources: Inventory records`, `Tools: Low-stock products`, `Products: 19`, `Limit: 20` | `04-inspect.png` |
| UP then change to DOWN | `Reported — thank you`; DOWN required a reason, accepted note `Device test note` | `05-feedback-sheet.png`, `06-down-reasons.png`, `08-down-saved.png` |
| Rating survives reopening | DOWN remains selected on the reopened thread | `08-down-saved.png` |
| Review queue (OWNER) | `Total 1 / Open 1 / Good 0 / Bad 1`; row shows `Bad response`, `Incorrect data`, note, question and bounded answer excerpt | `13-feedback-review.png` |
| Review state | `Reviewed — no action needed`, `Reopen report`; counts `Total 1 / Open 0 / Good 0 / Bad 1` | `15-reviewed.png`, `16-reviewed-counts.png` |
| Fresh 19-product set | `19 products need restocking, with a combined gap of 721 units...` | `22-fresh-answer.png`, `27-follow-up-top.png` |
| Scoped follow-up | `Which of those are in Keyboards and Mice?` returned **9 products**, `Category Keyboards and Mice` | `23-forced-follow-up.png` |
| Follow-up provenance | `Tools: Filtered previous results`, `Products: 9`, `Category: Keyboards and Mice`, `Limit: 50` | `24-follow-up-inspect.png` |

The follow-up answer was longer than one screen; `23-forced-follow-up.png` shows its footer and
`24-follow-up-inspect.png` its expanded Inspect panel.

## The defect the device found

The first device pass asked the same narrowing question against the 19-product set and the assistant
answered **“I couldn’t find an active category labeled Keyboards”** with `No data read`: it answered
from memory instead of calling the offered filter. The server now names
`filterPreviousResults` as the required tool on the first provider call of a recognised follow-up,
and a filtered read is counted as `Inventory records` and can seed the next set. That fix deployed as
`9f81e34`; the table above is the repeat on the same device after the deploy.

## Boundaries

- The ratings and review row above are production test data on the demo tenant.
- The review queue was exercised as OWNER. MANAGER/STAFF denial is covered by
  `ai115-feedback-review.test.tsx` and the server route gate, not by a second device login.
- The follow-up evidence proves category filtering. Location, low-stock and out-of-stock filter
  variants are covered by the DB test, not by separate device turns.

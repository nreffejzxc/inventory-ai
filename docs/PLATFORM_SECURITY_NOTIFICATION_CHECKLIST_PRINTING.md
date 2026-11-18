# Printable checklist - reproducible PDF regeneration

**Status:** **DOCUMENTATION AND LOCAL TOOLING ONLY.** This procedure does not send a notification,
activate an alert, change the checklist content or touch production.

The Markdown checklist is the source of truth. The PDF is a generated artifact beside it. The
renderer is `scripts/render-notification-checklist.mjs`; it uses free tools only and refuses to
replace the PDF unless the result is exactly one page with the required fields.

## Prerequisites

| Tool | Why it is needed | Free? |
| --- | --- | --- |
| Node.js 24 | Runs the renderer (same runtime as the project) | Yes |
| Google Chrome or Microsoft Edge | The print engine that produces the PDF | Yes |
| `npx` | Runs the pinned Markdown parser `marked@18.2.1` | Yes |
| Poppler `pdftotext` | Extracts text and counts page breaks for verification | Yes |

No package is added to the repository. `npx` downloads `marked@18.2.1` on first use. If Chrome is not
in a standard location, set `CHROME_PATH`. If Poppler is not on `PATH`, set `PDFTOTEXT`.

The Windows path is quoted as one `cmd.exe` command, so a checkout or `TEMP` directory containing
spaces is supported. That was exercised from a repository path and a temporary directory both
containing spaces; the result was still exactly one page.

## Regenerate

From the repository root:

```bash
node scripts/render-notification-checklist.mjs
```

Expected output:

```text
Verified exactly 1 page; wrote docs\PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf (... bytes).
```

The script:

1. Reads `docs/PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.md`; it does not edit it.
2. Renders the Markdown with `marked@18.2.1`.
3. Prints the HTML through Chrome at **Letter** size with the fixed print CSS in the script.
4. Extracts the PDF text with `pdftotext`.
5. Fails unless the page count is exactly **1**.
6. Fails if the text contains a replacement character or is missing any required field.
7. Copies the new PDF to `docs/PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf` only after all
   checks pass.

The listed fields are: Test ID, Primary contact, Cucumber, Owner signature, STOP, written
acknowledgement and redacted.

## Verify independently

```bash
pdftotext -layout docs/PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.pdf - |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('pages:',s.split('\f').length-(s.endsWith('\f')?1:0)))"
```

A successful regeneration must report `pages: 1`. The script's own check is authoritative; this is a
second, simple observation for a reviewer.

## If it fails

| Failure | Meaning | Action |
| --- | --- | --- |
| `Chrome/Edge was not found` | The print engine is not in a standard path | Set `CHROME_PATH` to the executable |
| `pdftotext could not read the PDF` | Poppler is missing or not on `PATH` | Install Poppler or set `PDFTOTEXT` |
| `Expected exactly 1 page, got 2` | The Markdown or print CSS has grown | Do not commit a multi-page PDF; reduce spacing/fonts in the script's CSS or shorten the checklist, then rerun |
| `Required text "..." is missing` | The source lost a required field | Restore the field in the Markdown; do not hand-edit the PDF |
| `replacement characters` | A non-ASCII glyph did not map cleanly | Use ASCII separators or update the print font; rerun |

The PDF must never be edited by hand. A source edit followed by a successful regeneration is the
only supported update path.

## Cost and restrictions

- No paid service, domain, SMS, pager, analytics or document service.
- No notification is sent by rendering the PDF.
- No security alert is activated by rendering the PDF.
- The PDF is a print artifact, not evidence that the two-contact test was run. The evidence record
  remains **NOT RUN / PENDING** until both contacts confirm and acknowledge.

## Related records

- [`PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.md`](PLATFORM_SECURITY_NOTIFICATION_TEST_CHECKLIST.md) -
  the source checklist.
- [`PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md`](PLATFORM_SECURITY_NOTIFICATION_EVIDENCE.md) - the
  pending test record.
- [`PLATFORM_SECURITY_CONTACTS.md`](PLATFORM_SECURITY_CONTACTS.md) - contact and activation rules.

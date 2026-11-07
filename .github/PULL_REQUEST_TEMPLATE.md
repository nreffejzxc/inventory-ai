## Summary

<!-- What changes, and why? Link the roadmap record or issue if there is one. -->

## Documentation impact

- [ ] I updated the document that owns this change (see `docs/README.md`).
- [ ] I updated `docs/DEVELOPMENT_LOG.md` with the session outcome.
- [ ] I added a dated `docs/DEVELOPMENT_ROADMAP.md` record for a shipped change or a decision.
- [ ] No documentation change is needed because:

<!-- If the last box is checked, say why a reader of the existing docs would not be misled. -->

## Verification

<!-- List the exact commands run and their results. Do not claim a check that was skipped. -->

- `node scripts/check-docs.mjs`:
- Relevant tests / typecheck / lint:

## Repository

- [ ] The branch is based on current `main` and contains no unrelated uncommitted files.
- [ ] The four required checks (`server`, `mobile`, `secret-guard`, `attribution-guard`) are green.
- [ ] I will close on a clean, synchronized `main` after merge (`node scripts/check-repo-state.mjs`).

## Deployment

- [ ] This change does not touch `server/`, so it does not trigger a Render deploy.
- [ ] This change touches `server/` and the production deploy is intended and authorized.

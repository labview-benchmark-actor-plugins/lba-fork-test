## Summary

<!-- What changes, and which requirement, ADR, or issue it serves. -->

## Definition of Done

Merge only when every applicable item of the Definition of Done
(`docs/dod/definition-of-done.md`) holds. The **DoD Gate / dod** status check
enforces it.

- [ ] **Verification**: `node experiments/verify-local-gates.mjs` is green.
- [ ] **Test coverage**: the committed coverage artifact meets the floor (`PR Coverage Gate / coverage`).
- [ ] **Traceability**: every requirement resolves to a CodeRef and a TestID, and `docs/requirements/rtm.csv` is consistent.
- [ ] **Configuration**: GitFlow governance holds, significant decisions have an ADR, and the CM plan is current.
- [ ] **Architecture**: `docs/architecture/overview.md` reflects the change.
- [ ] **Information items**: the SRS, RTM, test plan, and user guide are present and current.
- [ ] **Evidence**: the change keeps re-runnable proof (receipts or self-tests), not prose claims.

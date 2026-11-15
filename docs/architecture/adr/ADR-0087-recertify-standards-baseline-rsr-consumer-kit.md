# ADR-0087: Re-certify the standards baseline at repo-standards-review v0.4.1 through the RSR consumer kit

- Status: Accepted
- Date: 2026-11-14
- Amended: 2026-11-14 (the kit and governance pin move to v0.4.2, commit `5a3aa9da`, workbench
  `sha256:913bba59…cfe5`, which LF-pins the kit's root files; the v0.4.2 deep run gives a byte-identical raw
  score, so only the source identity changes, #52)
- Owner: LINUX
- Traces to: LBA-REQ-008, LBA-REQ-096
- Amends: [ADR-0079](ADR-0079-standards-release-risk-overlay.md). The overlay is unchanged; the static
  baseline it preserves is the v0.4.1 capture, re-identified as v0.4.2 by the amendment above.

## Context

The repository was certified against `repo-standards-review` v0.2.19 (commit `d44f210d`) in 2026-08.
`release-components.json`, both retained baselines and the agent contract pin that release. The CM plan
allows the stamp to move only together with a re-validation.

RSR has since released v0.4.x. It publishes a consumer kit and one release manifest per tag (tag, commit,
workbench image by digest) at `github.com/svelderrainruiz/repo-standards-review-consumer-kit`, so that every
ecosystem repository pins a release the same way (VITechnologies/projectbuddy#277). Two findings came out of
the first v0.4.x run against this repository:

- Since v0.2.20, RSR scores the DoD gate on a 0-5 scale. A PASS needs an itemized checklist that contribution
  or pull-request guidance links to. The exit criteria here were a table only, so the gate scored 2/5.
- The v0.4.0 workbench reported line endings as unknown for every mounted repository. RSR v0.4.1 fixed this
  (VITechnologies/projectbuddy#279).

## Decision

- Adopt the consumer kit at v0.4.1:
  - `.repo-standards-review.json` pins the release, and `.cruft.json` links the kit at the same tag.
  - The kit's LF rules head `.gitattributes` and end with the kit's closing line; this repository's own rules
    follow. The answers pin `*.py` and the shebang PowerShell scripts to LF, and exempt the Windows-captured
    `win-vm-*.json` fixtures and the Windows-container evidence, which keep their CRLF bytes.
  - The `repo-standards-review` workflow runs the kit's check, which compares the pin with the published
    manifest.
- Move the governance pin in `release-components.json` to v0.4.1 (commit `6386084c`, workbench digest
  `sha256:c31d824d…4e9b`). A local gate requires the kit pin and the governance pin to name the same release.
- Carry the seven DoD exit criteria as a checklist in `.github/pull_request_template.md`. The
  `dod-definition-present` gate keeps the checklist equal to the DoD table.
- Re-certify `standards-score-baseline.json` and `release-risk-baseline.json` from one v0.4.1 `release-gate`
  deep run, with the standards corpus mounted read-only. The run found:
  - all five areas at 5/5 and all six gates PASS (DoD confidence is now High);
  - no contradictions;
  - 319 executable scripts pinned to LF.
  
  The release-evidence overlay stays at 12/28 (BLOCKED): it counts this repository's own release proofs, which
  did not change.
- Records made against v0.2.19 stay as written: per-ADR stamps, ADR-0079's context, earlier CHANGELOG entries,
  and past proofs.

## Consequences

- Later RSR releases arrive as `cruft update` changes (VITechnologies/projectbuddy#276). Each governance bump
  still re-certifies both baselines and bumps the `agents` and extension versions, as `release-components.mjs`
  requires.

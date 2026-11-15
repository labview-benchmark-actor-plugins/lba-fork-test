# ADR-0088: lbabus lives in its own repository; the extension vendors a pinned release

- Status: Accepted
- Date: 2026-11-15
- Owner: LINUX
- Traces to: LBA-REQ-007, LBA-REQ-013

## Context

`lbabus`, the coordination bus CLI, grew inside this repository under `tools/collab-cli`. For the 1.5.2 release the
operator asked for it to become its own repository and an ecosystem component in its own right, so its work is
tracked as individual issues. [svelderrainruiz/lbabus](https://github.com/svelderrainruiz/lbabus) was split out of
`develop` with its history, adopted the repo-standards-review consumer kit, and publishes tagged, attested releases
(`vX.Y.Z`).

The operator also asked to remove the environment-variable prefix inherited from vi-history-suite (#63). lbabus owns the bus
environment contract, so that rename starts in lbabus (0.16.0) and the extension follows.

Consuming lbabus as a downloaded binary everywhere (workflows, reviewer VMs, clean rooms) is a larger change, tracked
in #57.

## Decision

- lbabus is developed and released only in svelderrainruiz/lbabus.
- For 1.6.0 this repository **vendors** a tagged lbabus release: `tools/collab-cli` equals the release's
  `tools/collab-cli` tree byte for byte, plus this repository's release-governance files that live in the same folder
  (the release agreement, the reviewer allowlist, and their recorders and verifiers).
- `tools/lbabus-vendor.json` pins the lbabus repository, tag, commit, and the blob hash of every vendored file. The
  `lbabus-vendored-mirror` gate compares them with the index, fails on any extra file outside the governance set, and
  requires the tag to match the `lbabus` version in `release-components.json`.
- To update lbabus, release it in its own repository, then replace the vendored files and the pin together.
- The Ubuntu clean room builds lbabus from source at `svelderrainruiz/lbabus` and the same tag. The
  `cleanroom-lbabus-pin-matches-release` gate requires `cleanroom-manifest.json` `lbabus.source_ref` to equal `v` plus
  the `release-components.json` `lbabus` version, so a mesh never runs a bus with a different environment contract.
- Checks that guarded this repository's own files move into this repository's gate suite, because the vendored copy
  is lbabus's and is no longer edited here. The mesh Vagrantfile typed-peer wiring is asserted by
  `mesh-typed-peer-routing`, and the requirements-coverage ledger (formerly the `ci-reqs` Docker stage) runs as
  `reqs-coverage-ledger`.

## Consequences

- lbabus changes are reviewed, tested, and released once, in their own repository; this repository cannot drift from
  a published lbabus release.
- The in-tree build paths and reviewer tooling keep working until #57 replaces the vendored copy with the released
  binaries. The vendored harness no longer checks this repository's files; the gates above do.
- `collab-cli-release.yml` (the former in-repository lbabus release lane) is obsolete and is retired by #57.
- The release-governance files should move out of `tools/collab-cli` as part of #57.

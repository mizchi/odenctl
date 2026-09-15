# Repository tools

Development and verification tools are grouped here. Run them through the root
`justfile` or pnpm scripts so relative fixture and output paths use the checkout
root.

| Directory | Contents | Entry points |
| --- | --- | --- |
| [scripts](scripts) | SDK packaging, guest builders, telemetry composition, pinned tool installers, kumo checks | `just sdk-pack`, `just telemetry-test`, `just aws-kumo-test` |
| [formal](formal) | Executable placement/capability models and their claim ledgers | `just formal-check` |
| [perf](perf) | Performance budgets used by regression reports | `just perf-regression` |

Runtime code belongs in `crates/`, deployment configurations in `infra/`, and
architecture and planning documents in `docs/developer/`. Guest SDKs remain in
`sdk/`; the build scripts here consume those sources.

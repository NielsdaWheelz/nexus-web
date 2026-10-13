# memory image qualification

status: open, 2026-10-13; [owning issue](https://github.com/NielsdaWheelz/nexus-web/issues/571).

compose grants both required build secrets and rejects an unset key path. clean-build both disposable worker targets with an authorized read-only dependency key, prove a missing file fails, and inspect layers/output/runtime config for leakage. start no installed worker.

resolved when the required real checks pass with synthetic content and task-owned
resources; source/static proof is not live acceptance. delete temporary probes.

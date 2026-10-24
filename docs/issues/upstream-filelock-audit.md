# upstream filelock audit blocks dependency merge

the required upstream security audits fail on unchanged `filelock` resolutions: provider-runtime locks `3.29.0`; llm-agent-kernel locks `3.32.5`. both runs report `cve-2026-112940`, `cve-2026-112913` and `cve-2026-112907`, with `4.2.1` as the fixed version. these failures block upstream merge and release; passing transport tests does not waive the audit.

evidence: [provider-runtime failed audit](https://github.com/NielsdaWheelz/llm-calling/actions/runs/40050177546/job/120740890881) at commit `b6a693415d688269a24e6a78b18a6949ddadd198`; [kernel failed audit](https://github.com/NielsdaWheelz/llm-agent-kernel/actions/runs/40050318789/job/120741317356) at `dac96899082d4ec5deb1e1f532f4861c725cc126`. each `uv run pip-audit` exits 1. the provider change does not modify its lockfile; the kernel lock diff changes only provider-runtime's git revision. both vulnerable versions therefore predate this fix. upstream locks reach filelock through cachecontrol's `filecache` extra; nexus's current lock has no filelock package.

resolve in the upstream dependency owners: review the advisories and select a compatible fixed dependency graph, regenerate the locks normally, then update downstream exact pins where required. do not suppress the audit.

resolved when both upstream required audit jobs pass on the final locked revisions and the downstream graph still resolves with those exact pins. retain relevant existing checks for the dependency update. production exposure beyond the observed audited environments has not been assessed.

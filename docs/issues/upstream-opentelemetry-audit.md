# upstream opentelemetry audit blocks dependency merge

provider-runtime and llm-agent-kernel both lock `opentelemetry-api==1.44.0`. their required audits report `cve-2026-114603`, with `1.45.1` as the fixed version. nexus also currently resolves `1.44.0`. this is a runtime dependency of provider-runtime and blocks upstream merge and release; the bounded-event fix does not resolve it.

evidence: [provider-runtime failed audit](https://github.com/NielsdaWheelz/llm-calling/actions/runs/40050177546/job/120740890881) at `b6a693415d688269a24e6a78b18a6949ddadd198`; [kernel failed audit](https://github.com/NielsdaWheelz/llm-agent-kernel/actions/runs/40050318789/job/120741317356) at `dac96899082d4ec5deb1e1f532f4861c725cc126`. each `uv run pip-audit` exits 1. provider-runtime's `pyproject.toml` declares `opentelemetry-api>=1.36,<2`; its lockfile is unchanged by this fix. the kernel and nexus lock diffs change only the intended git pins, preserving `1.44.0`.

resolve through the owning dependency graph: review the advisory, select a compatible fixed version, regenerate upstream and downstream locks normally, and qualify the affected instrumentation boundary. do not waive the audit.

resolved when upstream required audits pass with fixed resolutions, nexus's final lock excludes the reported vulnerable version, and relevant existing checks pass. exploitability in the application's use of the instrumentation api has not been assessed.

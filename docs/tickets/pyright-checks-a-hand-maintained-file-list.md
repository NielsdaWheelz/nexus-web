# pyright checks a hand-maintained subset of the package

status: open · origin: 2026-09-17 slop sweep (claude session) · area: python
static gates · oi-159

`python/pyproject.toml [tool.pyright].include` is a roughly 100-entry
hand-maintained allowlist. it omits `services/search`, `services/browse`,
`services/podcasts`, `services/tool_runtime`, `services/resource_items`,
`services/transcripts`, `services/net` and many single files, so new code is
type-checked only if someone remembers to add it — the gate silently narrows as
the package grows.

running pyright over all of `nexus` yields 17 errors, measured 2026-09-17 on the
search PR branch.

fix: replace the list with `["nexus", "../apps/api/main.py",
"../apps/codex_agent", "../apps/worker/health.py", "../apps/worker/main.py",
"../deploy/hetzner/release.py"]` and fix the 17 errors.

prerequisite: none, though it is cheapest once the slice PRs that touch those
services have landed, so the 17 are not re-measured against moving code.

acceptance: `include` names directories rather than files, `./scripts/test`
passes with zero pyright errors, and adding a new module under
`python/nexus/services/` is checked without editing `pyproject.toml`.

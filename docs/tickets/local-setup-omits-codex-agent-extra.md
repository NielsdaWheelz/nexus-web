# local setup omits the codex agent extra

status: open · origin: 2026-10-02 cleanup verification · area: local dependency setup

`make setup` installs only `dev` (`Makefile:66-69`). the checked runtime imports
`codex_cli_bin` in `apps/codex_agent/enroll.py:8`, `exec_server.py:14`, and
`native_server.py:13`; that package belongs to the separate `codex-agent` extra
(`python/pyproject.toml:33-41`). ci already installs both extras
(`.github/workflows/ci.yml:39`). fresh setup therefore does not establish the
same dependency environment as the sole static gate expects.

this is source evidence; a fresh `make setup`-only failure was not run in the
current task. verification used both locked extras and passed the baseline gate.

fix: make the local locked setup install the extras required by the checked
runtime, consistent with ci. do not change dependency versions or the gate.

acceptance: in a fresh isolated checkout, `make setup` followed by
`./scripts/test` passes without a separate dependency repair.

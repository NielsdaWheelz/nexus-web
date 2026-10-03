# local setup readme omits shellcheck

status: open · origin: 2026-10-02 cleanup source review · area: local setup documentation

`README.md:15-30` lists local prerequisites, including actionlint, but omits
shellcheck. the sole gate requires it before any checks (`scripts/test:12-16`)
and checks tracked shell at `scripts/test:29`. following the documented list
can leave the gate failing with `error: shellcheck is required`.

evidence is source-only at `104851703db7f445143bb0fff79ec8a6a3d84bf3` and unchanged
fetched main `ca1bb2e62931bda7ccb239adea70c74d3eab54e7`; a fresh missing-tool run
is not_run. prerequisite: preserve the existing fixed host-tool contract.
fix: list shellcheck beside actionlint in the existing prerequisites.
acceptance: the documented host-tool list covers every `scripts/test:12` preflight
requirement; ordinary setup and the unchanged gate pass in an isolated checkout.

# release filter toolbar

the implementation is in pr #682 on `codex/filter-toolbar-20261019`; production
verification remains pending. local proof does not establish the shipped ui.

`deployment.md:3` requires a planned no-use window. its sole release entrypoint,
`deploy/hetzner/deploy.sh`, requires a clean merged source sha, successful
first-attempt backend publication, a ready production-target frontend for that
sha and `VERCEL_TOKEN`. the current operator environment has no `VERCEL_TOKEN`.

after local acceptance and temporary-resource cleanup, arrange the no-use window
and provision the token through the operator environment, merge the reviewed pr,
wait for its immutable artifacts, then use the normal release controller. perform
read-only production checks of idle/active filters, clear/reset, wrapping and
shared toolbar consumers; verify `/version` matches the released sha.

resolved when that release and read-only smoke pass. do not promote only the
frontend or bypass the release controller.

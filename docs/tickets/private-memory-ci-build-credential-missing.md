# private memory build credential is missing

status: open
origin: 2026-10-10 utc, inherited from pr #537; reproduced by pr #538
area: ci / private dependency acquisition

pr #538 run `38022622059`, job `114126668101`, failed in locked dependency
installation: `private memory build credential is invalid`. the environment
showed an empty `UNIVERSAL_MEMORY_READ_TOKEN`; `gh secret list` confirmed that
the repository has no such secret. existing local/dev-server process and nexus
env inputs supplied neither that key nor its file variant. no checks ran in
that job. pr #537 records the same missing-secret failure before its merge.
the complete local static gate passed after installing the final locked stack.
the owner approved pr #538's merge with this inherited setup failure recorded
on 2026-10-10 utc; provisioning remains open.

provision the intended token with contents-read access only to
`NielsdaWheelz/universal-memory`, following `deployment.md:105`; publish it as
the existing repository secret without broad operator credentials or bypasses.
acceptance: rerun the affected pr job; frozen dependency installation and
`./scripts/test` both pass. the backend-image workflow needs the same secret.

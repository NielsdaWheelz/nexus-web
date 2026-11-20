# docker desktop holds the model-catalog rehearsal checkout

the mac rehearsal at `1bafe9f21575` passed and removed its containers and private
inputs. docker desktop kept 394 read-only handles in `rehearsal-4pz7e9g9/checkout`.
one vm cache release reduced that to 12, including the two fake-provider scripts
and three javascript helpers. the dev-server cleanup guard still reports open
files. two shared codex containers continued running throughout.

after the vm releases the files, repeat the dev-server helper's locked mount,
open-file, git and evidence checks. close this when the detached checkout and
its worktree registration are gone and the four named evidence files still
match the rehearsal receipt.

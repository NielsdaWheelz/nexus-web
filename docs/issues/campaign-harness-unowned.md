# campaign harnesses are unowned copies outside the repository

problem: each campaign copies the previous campaign's harness into
`nexus-web-campaign-artifacts/<date>/<slice>/harness`, which is not a git
repository. the 2026-10-21 notes harness lists its bases as "copied, renamed,
never run". that harness is a second stack implementation beside `./scripts/lab`:
its own compose, up/down, supabase rewriting, image build and web build stamp.

the copies carry unverified rules forward:
- `2026-10-18/refs/harness-changes.md:14` decided "docker desktop is the owner's
  app (down) and is never launched" while desktop was quit.
- every later harness kept its own colima vm (`engine.sh`; `notes/design.md`
  §12; `decisions.md` "## environment").

impact: fixes made in one copy do not reach the others. on 2026-10-21 a 12 gib
colima vm ran beside docker desktop's 24 gib vm. it rebuilt `c3nt-worker:dev` on
every checkout switch (`up.sh`), writing about 17 gb in 1.5 h.

evidence: the harness README; `engine.sh` (`colima start ... --cpu 6 --memory 12`);
32 artifact notes that mention colima.

fix: campaigns become lab invocations with temporary cases, and the artifacts
directory holds outputs only ([lab-host-budget](lab-host-budget.md) §1,
macbook-capacity d1/d5). an owner decision on retaining provider fakes is
required.

resolved when a campaign runs end to end through `./scripts/lab` in dedicated
checkouts, with no executable harness under `nexus-web-campaign-artifacts` and
no colima profile.

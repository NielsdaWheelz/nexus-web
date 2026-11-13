# librarian release configuration

the owner approved publication and release on 2026-11-12. the canonical
publisher installed the candidate postgres pin with only `POSTGRES_IMAGE`
changed. the coordinated release completed, recreated postgres under its
stopped-writer and backup checks, and passed public identity and health checks.
the separately approved follow-up publication and release of `c828088a2e97`
completed on 2026-11-13 utc with the same postgres-only configuration boundary.

the default private inputs also differ from the published configuration in
`FEED_REFRESH_DUE_LIMIT`, `FEED_REFRESH_DUE_SCHEDULE_SECONDS`,
`PODCAST_REFRESH_DUE_LIMIT`, and `PODCAST_REFRESH_DUE_SCHEDULE_SECONDS`.
publishing those defaults would change unrelated scheduling. preserve both
published feed values and the absence of the two podcast keys in private
publication inputs. preserve the null memory declaration, backup bytes, and
tunnel declaration. the proposed application delta is `POSTGRES_IMAGE` only.

`deploy/hetzner/sync-env.sh` owns input overrides and publication;
`deployment.md` owns ordering and the no-use window. before another publication, compare
the captured configuration hashes with the live pointers and verify the private
inputs still produce only the reviewed digest change. never edit a sealed
candidate or publish the unrelated scheduling changes implicitly.

resolved when the remaining default-input drift has an explicit owner decision
and ordinary publication inputs reproduce the intended scheduling. keep private
inputs and proof outside git.

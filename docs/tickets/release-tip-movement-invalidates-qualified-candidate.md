# release candidate must survive unrelated main advancement

status: open; owned by the post-release deployment-tool rewrite
origin: 2026-10-13 production release, pr #572
area: release tooling / immutable candidate selection

the qualified `700003128170df1b53070955cfde32cf0d8ec61c` candidate was refused
before production mutation at 20:31z because #572 advanced main to
`405e9345ec2d7cc8e5a8c50218df16105d856b77` at 20:28z. `deploy.sh:47` and
`release.py:309` require clean head and freshly fetched main to equal the
candidate. the new commit replaces four shared runtime dependencies, requiring
fresh runtime qualification despite unchanged migrations and reader repairs.

the same refusal recurred for qualified `405e9345` after #573 advanced main
to `16763c3cd4a7cb0b54520e99ec388fb82d573b9d` at 20:43:28z. that narrower
change fixes the disabled memory transport and retains all dependency pins;
its image identity and cold reader checks can carry the unchanged capacity
proof. neither refused attempt reached the backend controller.

the owner requested a merge hold, but #575 advanced main at 23:19:26z and
#577 advanced it again at 02:52:39z on october 14. #577 superseded the
qualified `443eda51` transport repair with `b6768bee`, changing metadata,
source settlement and jobs, and adding migration `0277`. its additional
rehearsal and qualification must finish before deployment.

the release session now enforces the existing hold with temporary read-only
protection on main, including administrators. the prior state was unprotected
with no rulesets. ownership, exact settings and restoration obligation are in
campaign artifacts `2026-10-13/release/main-release-freeze/`. #578 is held for
an explicit handoff to its owner after release acceptance. restore the prior
settings only after checking that the protection still matches this session's
owned configuration.

this release keeps the existing controller contract. the later rewrite should explicitly
separate immutable application selection from controller identity and current
development tip. retain first-attempt main-push ci provenance, digest and web
identity, matching source/config inputs, and migration ancestry checks. do not
fake refs or bypass the controller.

acceptance: on the devbox, qualify a candidate, advance main independently,
then deploy that exact candidate through the supported entrypoint; prove the
backup, migration, health and promotion boundaries retain its identity.

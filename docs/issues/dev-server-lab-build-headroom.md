# dev-server lab image-build headroom

repeated native x64 qualification image builds exhausted available host
headroom before the next application could start. this is a host capacity prerequisite; runtime/product and
occupied-web-port qualification already passed there.

on 2026-10-20, `dev-server` had 11 gb free before prerequisite installation and
2.9 gb after fresh worker/auth image acquisition. the migration-fault image build
for run `20261020-024103-255335129fbb` crossed the temporary coordinator's 1 gib
free-space threshold. it interrupted that invocation before store creation;
available space recovered to 2.0 gb. generated inputs and the checkout lock were
removed. historical evidence: the temporary task worktree's
`.nexus-local/setup-fault-qualification/migration-failure.runtime.log` and the
coordinator's free-space failure. that worktree and its task tools were removed
after qualification; 1.89 gib remained free. removing the ten exact unused
task worker image tags later recovered 1.31 gib, leaving 3.17 gib free; shared
image/dependency/build caches were preserved. another cold build is not qualified.

remaining image-build fault checks moved to the mac host. do not prune unrelated
images, build caches, volumes or projects. the host owner must provide adequate
free space or explicitly identify disposable cache ownership before another
cold/source-invalidating build.

the lab now shares a dependency-hash checkout worker image; source-only commits
reuse it without building. [checkout worker images](../local-rules/testing-standards.md#checkout-worker-images)
owns its inputs and retention contract. dependency changes still need a cold
build, and native x64 cold-build headroom remains unqualified.

resolved when the native host can complete the intended image build and runtime
qualification with adequate free-space headroom, preserving unrelated resources.

on 2026-10-22 scoped removal of eleven proven unreferenced image copies recovered
1,661,022,208 bytes, leaving 7,296,786,432 bytes free. all 111 containers, 21 volumes
and both running builders were preserved. six retained search qualification
volumes consume approximately 31.8 gb; their receipts do not prove disposal is
safe. shared build cache also remains. the host still falls below the backend
publisher's 8 gib floor. PR #739 moved that publisher to an isolated hosted vm;
this lab capacity issue remains pending an explicit retention decision or more
capacity.

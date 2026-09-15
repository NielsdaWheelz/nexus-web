status: open
origin: 2026-09-12 reader pr #238, ci `34718249742`
area: ci action runtime

the run annotates `docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f`
as targeting deprecated node 20 while forced onto node 24.
after #254, `.github/workflows/backend-images.yml:49` owns that immutable pin.
setup succeeded; this warning did not cause the job timeout.

prerequisite: review the action's supported runtime and upgrade notes.
update its pin to a supported runtime release and retain the existing buildx
setup contract.

acceptance: the direct `./scripts/test` contract passes, and the ordinary backend
publisher sets up buildx without the deprecated-runtime annotation. do not add
a separate hosted test or workflow gate.

2026-09-15: publisher `34942132865` for
`f353cb3ca0f4859807d9911c4e7a30b4b8af3412` repeated the warning; buildx setup,
image publication and cleanup all succeeded. this remains maintenance work, not
a restoration release blocker.

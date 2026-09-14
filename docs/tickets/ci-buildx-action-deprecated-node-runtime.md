status: open
origin: 2026-09-12 reader pr #238, ci `34718249742`
area: ci action runtime

the run annotates `docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f`
as targeting deprecated node 20 while forced onto node 24.
`.github/actions/setup-test/action.yml:81` owns that immutable pin.
setup succeeded; this warning did not cause the job timeout.

prerequisite: review the action's supported runtime and upgrade notes.
update its pin to a supported runtime release and retain the existing buildx
setup contract.

acceptance: canonical workflow/static proof and a hosted setup pass with buildx
available and no deprecated-runtime annotation for this action.

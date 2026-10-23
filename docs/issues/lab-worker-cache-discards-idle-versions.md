# worker image retention discards other idle dependency versions

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/worker_checkout_image.py:182-190` removes every other
`nexus-worker-checkout:*` tag whose image no container references. alternating
worktrees with different dependency inputs therefore loses completed-image
reuse as soon as the previous worktree's containers are gone. buildkit may
retain layers; this does not imply a full dependency reinstall every time.

this trades minimal tagged-image retention for repeat build invocations.
the source establishes eviction; its actual startup cost remains unmeasured.

if repeat work shows material churn, retain idle versions within an explicit
bounded cache budget, deleting only owned unreferenced artifacts under the
acquisition/retention lock. resolved when repeated alternating dependency
versions reuse their images within that budget and reclamation preserves every
image pinned by an active or stopped consumer. docker capacity stays fixed.

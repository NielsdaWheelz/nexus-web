# retained undo misclassifies newer input and strands its successor

hold a shared empty note's removal acknowledgement, undo, then checkpoint rich b
in its provisional child before releasing the reply. `journal.bindDraft` compares
newest b with the retained historical a and marks a false conflict. b survives,
but delivery is parked. compare the immutable restored a with canonical a instead.

the inverse then seals as `insert_link`; its acknowledgement has no body lane.
its named body successor also needs the exact retained-body binding preserved
through that inverse's settlement. an arbitrary insertion cannot grant body
authority. reuse existing causal facts, retaining only proof for this binding.

resolved when the held-response journey delivers exact b to the retained note,
without conflict or stranded dependency, while a real historical body mismatch
still preserves the branch for explicit review.

lab 16 at `fae96229c` confirms the equal-body red: rich b remains checkpointed at revision 5, canonical a remains empty, and the branch has `the retained note differs from the restored draft` against saved a/version 1. b is parked as `E_WRITING_DEPENDENCY_REVIEW`, still naming the restore intent. artifacts are under `20261021-164438-723cb535048c/artifacts/playwright-retained-undo`. the paired actual canonical-c change already keeps b, exposes c and sends no automatic b write; editor continuity fails separately.

source repair: retained bindings now certify immutable restore a and carry their exact restore intent id. binding retains current b/revision/selection. that inverse's final canonical acknowledgement rechecks its immutable carried a before granting the existing scalar version proof; terminal-before-admission reads the same authored context proof. no generic `insert_link` grants body authority, and a genuine c mismatch still installs conflict and parks b. live qualification remains pending.

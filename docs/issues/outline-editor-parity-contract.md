# editor parity lacks a complete behavior contract

the original target was roam-style editing with obsidian/apple notes presentation.
its implementation contract is split between
[outline interaction](../modules/notes.md#outline-interaction) and the
[local-first specification](../local-first-writing-spec.md#commands-and-local-composition).
the six fixed commands, native editing, focus and session history are implemented
and qualified. that does not establish complete parity with either product.

no editor-focused contract reconciles the original target with the implemented
behavior, deliberate differences and remaining gaps. for example,
[selected-range arrangement](outline-range-arrangement.md) is unsupported.
this leaves completion claims broader than the actual specification and proof.

resolve by defining the bounded editor behavior and presentation target,
reconciling the original requirements with the current interaction contract, and
making omissions and accepted differences explicit. required behavior needs its
actual verification or a separate unresolved issue; passing local-first storage
and capacity gates alone cannot close this gap.

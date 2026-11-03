# contained work conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: components/media/containedWorks/PartEditor.tsx35 derives `this work or its source changed.` from generic conflict/status. criterion 18 requires an owner proving the cause.

impact/counterexample: unchanged entity + owned database transaction busy. python/nexus/api/edge.py93-99 catches DatabaseBusyError and emits E_RESOURCE_CONFLICT. no changed entity is required. media_parts.py106-107 typed E_PART_CONFLICT additionally covers preparing_structure, existing_piece, identity_conflict, published_piece; even that code alone does not prove movement.

minimal proposed repair: generic409 says fact alone. simplest: remove this reason for all409; retain guard flags, current-proposal review and deliberate retry. optionally retain changed cause only for E_PART_CONFLICT details.reason navigation_changed/definition_changed/candidate_changed/source_changed after explicit discrimination.

resolved when the generic-conflict counterexample produces no unproved changed/elsewhere cause while conflict safety remains intact. root owns repository adoption; this audit changed no product code and ran no lab.

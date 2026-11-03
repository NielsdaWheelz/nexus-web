# media admission conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: lib/media/admissions.tsx71-73,85 derives `this item changed.` from generic conflict/status. criterion 18 requires an owner proving the cause.

impact/counterexample: unchanged entity + owned database transaction busy. python/nexus/api/edge.py93-99 catches DatabaseBusyError and emits E_RESOURCE_CONFLICT. no changed entity is required. both source-refresh and metadata-search intents see edge-owned generic409 before their domain work; same code also carries actual state guards.

minimal proposed repair: remove only E_RESOURCE_CONFLICT cause text; generic command fact alone. preserve definiteRefusal classification, original frozen body, refusal retirement and unknown semantics. do not call it busy.

resolved when the generic-conflict counterexample produces no unproved changed/elsewhere cause while conflict safety remains intact. root owns repository adoption; this audit changed no product code and ran no lab.

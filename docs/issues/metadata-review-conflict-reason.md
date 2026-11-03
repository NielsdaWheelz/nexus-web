# metadata review conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: components/media/MetadataResearchActions.tsx63 derives `this result changed.` from generic conflict/status. criterion 18 requires an owner proving the cause.

impact/counterexample: unchanged entity + owned database transaction busy. python/nexus/api/edge.py93-99 catches DatabaseBusyError and emits E_RESOURCE_CONFLICT. no changed entity is required. review endpoint cannot distinguish edge-owned transaction busy by this generic code.

minimal proposed repair: generic E_RESOURCE_CONFLICT says owned fact alone (`couldn’t mark this reviewed.`), or route it through outcome.fail which gives Refused no reason. retain 404 absence branch, pending/unknown state and button lifetime.

resolved when the generic-conflict counterexample produces no unproved changed/elsewhere cause while conflict safety remains intact. root owns repository adoption; this audit changed no product code and ran no lab.

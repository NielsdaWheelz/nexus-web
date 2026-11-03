# podcast command conflict reason

problem at dabdec901ef5a754506a5e3deaabaa961e66e020: lib/podcasts/commands.tsx92; lib/podcasts/paneState.ts42-45 derives `its libraries changed meanwhile.` (Import: `it changed meanwhile.`) from generic conflict/status. criterion 18 requires an owner proving the cause.

impact/counterexample: unchanged entity + owned database transaction busy. python/nexus/api/edge.py93-99 catches DatabaseBusyError and emits E_RESOURCE_CONFLICT. no changed entity is required. podcasts/subscriptions.py also uses E_RESOURCE_CONFLICT for id collisions and existing imports; podcasts/imports.py for attempt mismatch. neither status nor generic code proves libraries moved.

minimal proposed repair: remove blanket status409 cause; remove generic E_RESOURCE_CONFLICT/E_CONFLICT from podcastRefusalReason; retain typed E_SELECTION_CHANGED. leave sender Refused/check/read and unknown/replay handling unchanged.

resolved when the generic-conflict counterexample produces no unproved changed/elsewhere cause while conflict safety remains intact. root owns repository adoption; this audit changed no product code and ran no lab.

# held retry ignores offline while admission remains ready

`useResendFeedback` reads only admission. browser offline events do not change
`Ready`, so an unresolved command can keep an enabled retry while its owner
refuses to send offline. the held control and the actual command gate disagree.

evidence at feedback-homes72cf9db84: `components/feedback/Feedback.tsx:239-251`
subscribes only to admission and tests offline only through its transport.
`lib/native/admission.ts:11-15` binds online/focus, not offline; `remoteReady`
can therefore remain true. these paths are under `apps/web/src/`.
the collections repair's a58a1598d browser journey reproduced the enabled
held retry in both engines after a fresh successful read and then offline;
its send callback correctly refused locally. no extra server write is claimed.

resolve at the shared feedback owner with the existing connectivity observation
and canonical offline reason. preserve update-only recovery, actual shell sign-in,
checking busy state and deliberate online browser retries while admission is
unavailable. prove ready/offline/online transitions update the held control without
sending automatically; retain the shared update and sign-in behavior.

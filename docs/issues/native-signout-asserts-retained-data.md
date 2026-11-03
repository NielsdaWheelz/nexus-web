# native startup sign-out feedback asserts retained data after a timeout

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: DeviceWorkspace maps every rejected sign-out to `sign out didn’t finish. this device still holds account data.`, even when native cleanup completed and only the bridge answer is lost.

evidence: web `lib/native/DeviceWorkspace.tsx:105-110,118,128,132` uses any cleanupFailure for that line. `lib/native/client.ts:112-119` can reject at30s with E_NATIVE_TIMEOUT independently of the native outcome. android `DeviceSession.kt:494-511` commits a null binding, purges, marks completion and publishes before reply delivery; only a genuine E_LOCAL_CLEANUP proves incomplete cleanup.

proposed words: typed E_LOCAL_CLEANUP keeps the existing fact and reason. unknown bridge outcome: `not sure sign-out finished.` + `it may have gone through.`; `retry` uses the existing sign-out owner. alternatively read startup through the already existing owner and report only its actual state. no new protocol.

resolution proof: delay/drop the completed native reply past the bridge timeout; no line claims account data remains without a current read or typed cleanup cause. an actual failed purge still has the appropriate cleanup recovery.

source finding; bounded correction and outcome qualification remain pending.

root refinement: a typed incomplete cleanup does not necessarily prove actual account bytes remain after partial deletion. use the bare incomplete-signout fact unless a current observation proves retained data; reserve the canonical unknown line for an unanswered native outcome.

# qualify same-account reauthentication

installed same-account sign-in restores credentials but leaves authored transport
paused. the startup contract in
`docs/local-first-writing-spec.md` requires same-account sign-in to resume
transport while retaining the confirmed local account.

the extended `apps/web/.nexus-lab/cases/authored-lifecycle.spec.ts:80` passed on
`6ab5d5f77`, canonical lab `20261025-234810-3c0001c43255`: actual 401, local
edit and reload, then real same-account password sign-in. binding, replica and
pending command sequence stayed unchanged; the exact rich body uploaded with
no new semantic touch. this browser result does not qualify installed android.

resolve by qualifying the installed host's corresponding admission path: retain
the binding, replica and pending command, sign in through the supported flow,
then prove the exact writing reaches the server without purge, replacement
replica or a new semantic touch.

installed run `20261026-182755-aca105421c80` on checkpoint89 established a
product failure after successful same-account handoff. actual 401, local edit,
cold retained binding/replica/sequence, public account-menu sign-in and password
handoff passed; pending source acknowledgement remained false for 120 seconds.
canonical lab cleanup completed. retained run `api.log:151-162` shows handoff
consume 200, authenticated profile/account/workspace 200 and catalog 200, then
no authored request after restored credentials. page-index and real WebView IME
protocol checks passed earlier in the same run.

source cause: `lib/authored/sync.ts:64,78` stops scheduled transport after auth
failure; `lib/authored/native.ts:169-175` wakes only on hints/online/foreground.
`AuthoredBridge.kt:86` terminates its hint loop after 401/403/426, while its
session subscription at `:54` handles account retirement only. same-account
`DeviceSession.bootstrap` publishes Ready without restarting either paused
owner. foreground can precede handoff redemption and fail again.

the native authored bridge's existing session subscription now restarts hints
and emits its existing wake signal when the foreground, still-current bound
account regains remote admission. each session publication cancels the prior
hint job before checking current admission, so a late old-credential response
cannot strand its replacement. queued publications may already observe Ready;
a nonready-only cancellation would miss that race. local writing is not reopened
or reset.
installed qualification remains pending: rerun the same exact-body/upload proof
and preserve account, replica and command sequence.

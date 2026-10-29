# api 35 handoff remains unqualified

owned emulator 5580 (api 35, webview 124.0.6367.219) fails the real password
handoff before episode qualification. native ui says `couldn’t connect`; startup
binding stays null. physical api 36 phone and api 34 emulator complete this flow.
this blocks the episode journey on that api 35 emulator; it does not establish
an application defect or an environment-only cause.

evidence: disposable run `20261023-232653-8f5e8ccb1258`, runtime `d675c7217`,
`episodes-native.spec.ts:124`: expected bound viewer, received undefined after
30 seconds. fresh challenge equals callback challenge. api log has the handoff
code creation but no redemption/bootstrap. proxy settings are absent, airplane
mode is off, emulator network shaping is unlimited.

run `20261023-235402-f59a50133e8b`, diagnostic snapshot `a135ccc6f`, narrows the
failure to okhttp `RealConnection.connectSocket`: `ConnectException` caused by
another `ConnectException`, caused by `android.system.ErrnoException`. the owned
relay receives browser login/assets but no native redemption request. cached-store
and cookie lookup therefore completed before the socket failure. errno and socket
target were not captured. the packaged apk dex, kotlin classes and build config
all contain the correct `http://127.0.0.1:31043` origin in both the native client
and activity. device global properties/settings and per-network connectivity
state expose no proxy. retained platform logs supply no errno.

episode qualification uses the api 36 phone and api 34 emulator; no api 35 episode
proof is claimed. temporary auth diagnostics were removed. resolved when the
real password handoff binds the expected account and reaches native
redemption/bootstrap on api 35, followed by its episode journey.

quiet-feedback run `20261028-184437-596425143cd1`, source `f63fe0214`, reproduced
the missing redemption on owned api 35 emulator 5600: password handoff mint
returned 201 and the matching callback was delivered, but binding remained null
for 45 seconds and the ui said `couldn’t connect`. private evidence lives in
`nexus-web-quiet-feedback-native-proof/.nexus-local/lab/<run>/artifacts/`.
the same candidate's runs `20261028-181121-360c581fe1a6`,
`20261028-181942-eae8071fc471` and `20261028-182538-92926fab1385` completed binding
and real local journal-refusal/retry/offline-restart checks. this establishes
intermittence, not a new root cause or episode qualification.

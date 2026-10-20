# debug android cold start leaves the owned lab origin

problem: the unchanged debug shell's initial anonymous navigation did not reach
its webview page during action-menu qualification; android opened chrome instead.

evidence: run `20261020-010629-acffd31accfa`, isolated `emulator-5590`.
debug apk built successfully with base `http://127.0.0.1:64237` and owned host
`127.0.0.1`. android activity logs show the main activity followed by a chrome
intent for `http://localhost:64237/...`; android redacts the path. the app's
devtools page remained empty, and chrome displayed its first-run screen. the
driver was stopped before any native menu claim. root cause is not assigned.

repair: imported peer commit `983c1495b377de928c2771c9bb6a148247283d51`
as `58e4b7a04`: the supported next middleware-normalization setting preserves
the canonical redirect origin; the product password form owns lab bootstrap.
the peer independently qualified strict-origin and native-root login. our run
`20261020-013220-44e6adaae207` reached the actual app login screen through its
public login app-link and stayed in the main activity. no origin exception was
added. that run's automation timed out attaching to the already rendered webview;
it established no native menu behavior or combined default-launch result.

impact: default cold-start qualification on the combined cutover remains open.
the strict shell origin check stays exact.

resolved when a fresh anonymous default launch stays on the configured origin,
loads the actual webview, and its navigation/menu checks pass without widening
the origin allowlist or fabricating authentication.

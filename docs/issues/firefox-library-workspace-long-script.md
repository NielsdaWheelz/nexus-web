# firefox library workspace long script

firefox 158.0.1 hit a long-running workspace script while the disposable native
extension driver navigated authenticated `/libraries`. this may stall firefox
workspace navigation; the extension driver does not need that page for cookie
import and now uses `/login` instead. that avoids the navigation without fixing
the workspace behavior. the extension driver's separate full-tab popup rejection
is a correct security boundary and does not explain this workspace warning.

evidence: the private green1 `firefox-extension/geckodriver.log` in
`.nexus-local/lab/20261022-135251-10637dd74821/artifacts/` reports
`Script terminated by timeout` in `1904-62e8cd55efaaa9a8.js:1:43369`, under
`useMemo`. the case used a fresh headless system firefox profile and imported the
runtime's real browser auth cookies before a second `/libraries` navigation.

reproduce that authenticated navigation in a fresh firefox profile against the
production lab build; identify the source owner from the timed-out callback.
resolved when the same navigation settles without the long-script warning and
the library workspace remains usable. no cause or regression baseline is proved.

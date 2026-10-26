# a web probe timeout escapes the readiness retry

problem: one slow web probe aborts the disposable runtime rather than retrying
within the existing readiness deadline.

evidence: `a09557224`, lab `20261025-133924-aea99d328978`, reused production
package. `probe-web.mjs https://127.0.0.1:31023 …/web-tls/ca.pem` timed out after
6 seconds; driver never started and exact owned teardown succeeded.
`python/scripts/disposable_runtime.py:1226-1239` runs the probe with `timeout=6`
but catches only `RuntimeError`; `subprocess.TimeoutExpired` escapes that retry
boundary. no identity or certificate failure was established.

impact: transient startup delay discards an otherwise admitted lab attempt.

fix at `web_ready`: classify a probe subprocess timeout as not ready and retain
the existing overall deadline, exact identity check and tls verification.
resolve with a real owned web process delayed past one probe deadline, then
resumed before the overall deadline; startup must retry and still reject wrong
identity or persistent unavailability. no larger host allocation or trust bypass.

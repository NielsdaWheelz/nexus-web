# chromium transport disappeared during the headword room matrix

lab `20261114-175656-d5a0c710dc6c` completed chromium dark command checks.
in a fresh chromium profile for the light room, `fill` timed out after the
modifier check; failure screenshot capture then stopped responding. no owned
headless chromium process remained, while the bun driver (`83463`) stayed alive.
the lab owner (`82414`) received sigint for normal cleanup.

evidence is private `/tmp/headword-final.log`: chromium light cases 1, 2, 13,
17, 19 and 22 passed before `TimeoutError: fill: Timeout 30000ms exceeded.`
there is no evidence yet that the application caused the browser exit.

this interrupts verification and leaves the driver's browser protocol waiting.
repeat the affected check in a fresh owned browser, capture browser exit/transport
diagnostics, and establish bounded failure/cleanup before calling it resolved.

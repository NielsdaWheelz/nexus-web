# native firefox launcher lost its output pipe

one `takeover-green` a5guard launch failed at the temporary
`cases/native_firefox.py:43` while printing its webdriver address:
`BrokenPipeError`; the launcher exited 120. the unchanged native launch later
succeeded for all three a5 trials. the private `labrun/takeover-green.log` retains
the failure. its cause is not established.

this is distinct from playwright's unnoticed orderly firefox quit: this launcher
reported a broken output channel during startup. missing native guard trials must
remain a failed/incomplete result, even when another lane already passed.

resolved when an owned reproduction identifies why the control reader closed and
the launcher either completes its handshake or fails with bounded cleanup and a
complete diagnostic. do not infer a product failure or silently retry without a
fresh-profile receipt.

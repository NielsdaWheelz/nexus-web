# installed writing signout failure boundaries need qualification

problem: the live writer must resume after a failure before account teardown,
and must never resume after native account retirement, even if cleanup fails.
these two failure branches have source review but no installed runtime proof.

impact: the success path does not establish preservation of unfinished writing
or account fencing on failure.

evidence: `apps/web/src/components/appnav/AccountMenu.tsx` captures the writer
lifetime and distinguishes native cleanup/startup state;
`apps/web/src/lib/native/DeviceWorkspace.tsx` retires the old shell after
`E_LOCAL_CLEANUP`. the disposable installed release proved real authentication,
autosave, exit/download cancellation, reconnect and successful native local
signout. it did not inject player/unbind failure or post-retirement cleanup
failure. concurrent use of the shared emulator prevented further physical input;
no production fault injection or unrelated package changes were made.

resolve in an exclusively owned disposable native session: hold an ordinary
save, induce a real pre-retirement failure and prove the same account remains
editable/guarded and later saves; induce failure after the native tombstone and
prove old-account text/callbacks cannot return, while the native cleanup owner
can complete. use existing transport/filesystem boundaries; add no product seam.

# browser retirement outlives its account menu

worker retirement unmounts `SignOutProvider` through `BrowserWorkspace` before browser corpus deletion finishes. its later `form.submit()` is refused by the live guard; failed deletion loses the dialog that would report it. remote cookies remain and blocked removal has no owning retry surface.

reproduce with two real tabs and an open IndexedDB connection blocking corpus deletion. accept sign out; verify the surviving signed-out surface reports incomplete removal and retries after the connection closes. successful online removal must clear session cookies; offline removal must retain explicit signed-out admission. release delayed metadata responses after retirement and prove they cannot restore the binding.

fix in progress: the browser entry owns completion from the existing durable retirement marker, beyond account-menu lifetime. resolve with the real disposable lifecycle cases, including blocked deletion and cookie checks.

qualification red: source `efe55fb40`, disposable run
`20261025-142858-eb4e213a6792`, `authored-lifecycle.spec.ts:95`. after two tabs
commit offline writing and accept deliberate discard, the second tab remains at
“signing out on this device…” and its persisted account binding remains after
10 seconds. cancellation and expired-credential editing passed. determine whether
the hang belongs to repeated worker retirement, owner shutdown, or the attached
verification transport before changing the product; the cause is not yet proven.

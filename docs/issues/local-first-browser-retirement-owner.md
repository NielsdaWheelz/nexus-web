# browser retirement outlives its account menu

worker retirement unmounts `SignOutProvider` through `BrowserWorkspace` before browser corpus deletion finishes. its later `form.submit()` is refused by the live guard; failed deletion loses the dialog that would report it. remote cookies remain and blocked removal has no owning retry surface.

reproduce with two real tabs and an open IndexedDB connection blocking corpus deletion. accept sign out; verify the surviving signed-out surface reports incomplete removal and retries after the connection closes. successful online removal must clear session cookies; offline removal must retain explicit signed-out admission. release delayed metadata responses after retirement and prove they cannot restore the binding.

fix in progress: the browser entry owns completion from the existing durable retirement marker, beyond account-menu lifetime. resolve with the real disposable lifecycle cases, including blocked deletion and cookie checks.

qualification red: source `efe55fb40`, disposable run
`20261025-142858-eb4e213a6792`, `authored-lifecycle.spec.ts:95`. after two tabs
commit offline writing and accept deliberate discard, the second tab remains at
“signing out on this device…” and its persisted account binding remains after
10 seconds. cancellation and expired-credential editing passed.

run `20261025-144254-fe41634e3c58` detached the exact offline debugger socket
after the genuine retirement receipt. the worker was no longer debugger-attached;
the binding still remained after 35 seconds and cleanup reached its 30-second
control timeout. first retirement had already closed the database. the entry's
second retirement handshake waits on that same closing worker. the initiating
tab also navigated away: the menu's form submission races entry-owned cleanup.
live retirement must proceed directly to purge; the browser entry must own
completion, including remote session clearing. interrupted cold cleanup still
needs to establish retirement before deleting storage.

review follow-up: completion and explicit sign-in still lack a shared account
transition lock. a purger delayed before its remote signout can clear cookies
belonging to a newer explicit sign-in. serialize marker recheck, local purge and
remote cookie clearing with `beginBrowserSignIn` under one origin web lock.
prove it with a held real signout request: the new sign-in waits, then succeeds
after that request completes. the existing provider independently discards each
tab's retired writing runtime; do not duplicate that owner.

implementation now uses the live retirement receipt directly for purge, retaining
that receipt across a blocked-deletion retry. cold interrupted startup still
establishes retirement. the account menu no longer submits a browser form or
cleans browser storage; entry completion alone clears session cookies after purge.
actual lifecycle qualification is pending.

positive follow-up red, run `20261025-150229-4da010c81606` (lab22 trace): after local
current/retiring became null and signed_out true, tab b began its new login
at10806.679ms and got200; tab a's old signout POST stayed held until11081.555ms.
full retirement completion and explicit sign-in intent now share the origin
`nexus-authored-account-transition` web lock. completion rechecks the marker
after admission, so queued old owners cannot purge a later binding or clear
a later login's cookies. real green qualification remains required.

review found a caller gap: `LoginPageClient.tsx` OAuth links allow modifier-click
navigation immediately while firing `beginBrowserSignIn` without awaiting it.
that bypasses admission to the same origin transition lock. ordinary shell and
password actions await it. close this caller before claiming all explicit login
paths serialized; preserve intentional new-context navigation if retained.

provider sign-in now uses an explicit button: browser activation awaits the same
account admission, handoff activation retains its existing destination without
mutating browser binding. current-tab navigation replaces link modifier/context
menu navigation; no link activation can bypass the local precondition.

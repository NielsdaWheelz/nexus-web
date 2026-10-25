# the shell bypasses browser device admission

the early workspace rewrite in `apps/web/src/middleware.ts` returns before the
existing `resolveDevice` call. a fresh browser can authenticate but has no
`nx_device` cookie, so its first `/api/me/workspace-session` returns 400 and the
workspace cannot open.

observed in frozen commit `2dfc6fa4f`, disposable run
`20261025-124049-c886b2630ae7`: real password login reached `/lectern`, then
bootstrap failed with `browser authenticated primary navigation missing`.
the screenshot shows `couldn’t open your workspace`. the driver never started;
owned runtime cleanup completed.

preserve existing browser device identity when admitting the shared shell,
without making a locally bound offline account depend on remote authentication.
resolve when a fresh supported profile logs in, obtains its device identity,
provisions, and cold-reopens offline through the real shell.

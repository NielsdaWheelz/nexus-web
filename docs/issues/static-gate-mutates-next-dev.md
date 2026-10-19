# static gate mutates live next artifacts

problem: `./scripts/test` invokes the web typecheck, which deletes `.next/types`
and runs `next typegen` in the development server's output directory
(`apps/web/package.json`, `typecheck`).

impact/evidence: during shift-open's disposable live checks, concurrent runs
produced non-json 404s for existing `/api/me/workspace-session` and invalid-token
browser chunks. the api remained healthy; restarting next restored those routes
without application changes. serializing live checks alone did not repair the
affected server. type generation sharing its artifacts is the suspected cause.

current workflow: stop next before the static gate. resolve by isolating generated
type artifacts from a running development server while retaining the single gate.
proof: run the gate beside next; authenticated bff requests and browser navigation
continue succeeding throughout and afterward.

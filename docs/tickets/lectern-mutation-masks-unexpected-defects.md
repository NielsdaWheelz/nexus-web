# lectern mutation masks unexpected defects

status: open
origin: 2026-10-04, sol cleanup session; source review at 43e1fb44ceeb97e8ec43d2b7ea852d460452d0e3
area: web lectern mutation and reconciliation owner

`apps/web/src/lib/lectern/LecternProvider.tsx:164–176` preserves internal/invalid-response api errors but relabels arbitrary exceptions as network failures. `:185–186` classifies only by 4xx status. `:398–406` therefore parks internal500, invalid-response200, unknown response and generic faults in ordinary same-id retry; `:320–335` similarly parks any reconciliation get failure. this can block the fifo behind a defect while offering ordinary retry. api/client.ts:96–104 already names the same-system defect codes; docs/rules/errors.md prohibits this conversion. this is source evidence, not a mounted reproduction. a 500 response may follow a durably committed write: defect severity and outcome uncertainty are distinct; retain the frozen mutation id and replay/reconciliation truth when reporting it.

prerequisite: specify the existing unknown-write outcome, stable mutation id, parked retry, reconciliation, authentication and disposal contracts. classify actual modeled transport/domain errors separately at this owner; route unexpected exceptions to an observed defect port and settle waiting callers/lane deliberately. do not merely throw from the private enqueued task. a defect after installation may follow partial accepted effects; reporting cannot promise rollback or prove an uncertain remote write absent.

acceptance: actual public provider calls preserve healthy/replay/modeled failure behavior; internal/invalid/unknown and local callback faults reach an observed boundary without ordinary retry laundering or permanently pending promises. stale/disposed work cannot fault a replacement. no permanent framework or new generic retry policy.

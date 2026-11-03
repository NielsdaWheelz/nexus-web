# held scan bypasses current update and sign-in remedies

problem: the unknown scan start renders its own `retry` directly; its presentation never consumes current admission.

impact: a stale build keeps a sending retry instead of its sole usable update remedy; sign-in also lacks the shell remedy at the held owner.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; `apps/web/src/components/connections/ConnectionsSurface.tsx:116-118,131,172-174`; the shared owner is `apps/web/src/components/feedback/Feedback.tsx:239-251`. `Hold` is deliberately transport-agnostic at line260.

resolution: use shared resend presentation for unknown starts and appropriate live transport presentation for the status-read hold. preserve `not sure the scan started.` / `it may have gone through.` and `still finding connections.`; `retry` sends, `check` reads. prove update offers its actual remedy alone, original shell sign-in is used, and no automatic scan is sent.

status: source finding only; no runtime journey run. durable job ownership is not disputed. correction and behavior qualification remain pending.

# backend connector security update

problem: the production backend connector reports cloudflared `2026.10.3`.
upstream `2026.10.4` fixes metrics-endpoint issue `VULN-176088`:
https://github.com/cloudflare/cloudflared/blob/2026.10.4/RELEASE_NOTES .

impact: the backend remains on the affected connector. exploitability depends on
metrics access; this frontend recovery does not change or qualify that boundary.
the existing backend image is pinned at
`sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39`.

resolution: separately update the backend connector digest to a reviewed fixed
version, retain private metrics, and prove api tunnel readiness and application
transport. no backend restart belongs to the frozen frontend recovery.

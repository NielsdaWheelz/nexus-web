# workspace session rows are never pruned

status: accepted (open) · origin: 2026-10-09 workspace reauthoring (cleanup/workspace-reauthor), design Q9 · area: python workspace sessions

`workspace_sessions` holds one row per (user, device). nothing deletes a row:
a cleared or new `nx_device` cookie mints a new device id and a new row, and
the old row stays forever. reads touch only this device's row and the newest
other-device row (`ix_workspace_sessions_user_updated`), so stale rows cost
storage, not latency. each row is bounded by the api model (12 panes, ≤ 60
visits, hrefs ≤ 4096), about 255 KB at worst and a few KB in practice.

impact: low. unbounded growth per user over years of cookie churn; no
user-visible effect.

proposed fix: prune on write — keep each user's newest N rows (say 10) or rows
touched in the last 90 days, inside `put_workspace_session`.

resolved when: a user's row count stays bounded across repeated device-cookie
churn, and cross-device resume (`most_recent_elsewhere`) still finds the newest
other device.

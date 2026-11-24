# emulated api hits the release memory cap during retirement rehearsal

on 2026-11-24 at 11:21:32 utc, published amd64 api `bb944c27` exited 137
with `OOMKilled=true` under its 384 mib no-swap limit on macbook. the same
project had passed api identity, migration, admission and unread-route checks.
the browser saw 502s while opening a raw reader quote. the private receipt is
`model-availability-implementation.zn9mEw/takeover-quote-exact/api-oom.json`
under `~/.local/state/nexus-reviews/`.

the selected workload, its accounting and the emulator can all affect peak
charge. keep the larger mac rehearsal budget separate from production capacity.
close with a representative native amd64 api run at 384 mib, measured per-epoch
peak and oom counters, and a diagnosis or correction if it exhausts the cap.

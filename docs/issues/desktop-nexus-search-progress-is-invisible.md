# desktop nexus search progress is invisible

status: open; source-confirmed, delayed-request browser check pending.
origin: 2026-10-21 search latency review.

`apps/web/src/components/nexus/desktop/DesktopNexus.tsx:248` exposes busy state
through `aria-busy`; lines 367–369 announce searching only in an `sr-only`
element. no visible pending indicator accompanies already usable local/direct
results. `apps/web/src/lib/nexus/useNexusFind.ts:87-96` already supplies a
150-ms delayed busy signal. mobile now renders that signal visibly in
`components/switchboard/SwitchboardTask.tsx:129`.

impact: desktop search can appear complete while content retrieval is pending.
existing multi-second search evidence is recorded in
[the retrieval performance issue](semantic-ranking-still-scans-embedding-corpus.md);
this review did not measure a new browser interval.

reproduce: delay a real content preview in an isolated stack and inspect desktop
nexus after direct results appear. project the existing busy state visibly in a
reserved status area without moving the selected result.

resolved when delayed desktop search has visible and announced progress, fast
responses avoid flicker, successful rows remain actionable, and empty/failure
feedback correctly distinguishes pending from completed retrieval.

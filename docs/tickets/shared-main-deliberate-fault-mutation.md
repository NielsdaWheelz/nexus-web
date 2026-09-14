# shared main deliberate fault mutation

status: open
origin: 2026-09-14, bounded reader session
area: proof isolation

a separate process changed `apps/web/src/components/nexus/useNexusController.ts` in the shared bounded workspace to inject its named s2 defect, then ran `bunx vitest` directly. read-only `ps` observed pids 3107400/3107487 and the explicit replacement removing `historyReplaysRef.current, failure.retry`. unrelated snapshots can capture that intentional product fault. client proof checkout was isolated and unaffected.

prerequisite: the process owner finishes or stops its experiment. restore and verify the exact unfaulted source; run sensitivity only in isolated proof checkouts through `./scripts/test`.

acceptance: main has the reviewed unfaulted source and no active process mutates it for sensitivity; affected snapshots are checked or discarded.

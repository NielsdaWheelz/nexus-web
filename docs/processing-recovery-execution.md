# processing recovery execution

status: isolated implementation verified in part; production release and exact-item repair not run
origin: 2026-09-26 implementation of [the approved plan](processing-recovery-plan.md)

the branch uses the existing parser, publication, source admission, queue and
offline owners. migration 0242 records an ordered issue list on each publication
generation. no production data has been changed. private exact-source files and
disposable test-stack receipts remain under `/tmp/nexus-processing-review-20260926/`.

| acceptance | evidence on current worktree | remaining proof |
|---|---|---|
| a1 | exact joyce parses in a linux container with one cpu, 448 mib limit: 1.364 s, 150,429,696-byte cgroup peak, no oom; apparatus/html/text oracle sha256 `46f40b33c8adadbeab5e66cdb94177f1369f08ee319fd3eb732d82d4e867f00f`; isolated full publication has 95 fragments | open exact recovered production book |
| a2 | six exact epub sources published through disposable postgres/minio: pierre 4 navigation issues; odyssey, persuasion, sense 1 missing image each; toll 20; joyce 0. image-only/unsafe counterexamples reject. exact odyssey contract-3 archive passed python validation and chrome rendered its warning, location and path | production outcomes and installed android reader |
| a3 | exact toll retained bytes admitted by operator with original source and runtime hashes; replay returned identical receipt; worker published 33 fragments and 20 issues. authenticated http admission/retry of a fresh gutenberg alice epub returned the same receipt on replay; its worker published 15 fragments, 16 contents nodes and 1 asset. stale execution ids were rejected across all five running-job operations after attempt-number reuse. a preadmitted replacement on a published epub failed while its publication, cursor and readable state survived | production operator receipts |
| a4 | isolated stored-web normalization kept fragment id, text, authored anchor and cursor, advanced generation 1→2 and index revision 7→8 atomically. a real two-session postgres check held the media lock while a claimed revision-7 index worker waited; after normalization it returned obsolete within 0.9 s, with no deadlock or stale publication | both exact keats publications and paid indexes ready; cursor offsets checked live |
| a5 | exact gutenberg 38145 wrong-type web article was corrected in place; fresh unaltered worker job fetched the epub in 2.5 s, published 4 fragments/304 toc nodes/1 asset, and reader navigation opened. filing count 1 and history 7 events survived; replay/refusal checks passed | production correction and open |
| a6 | real postgres reconciliation excluded 25 older dead source and index obligations before each limit, admitted the younger jobless obligation once, and kept dead work suspended. url admission, email retained-artifact seam and storage-outage replay checked | postrelease observation for newly accepted work |
| a7 | exact fanged ordinary retry published 45 fragments, 35 toc nodes, 13 assets, no issues. isolated authenticated android on clean debug apk sha256 `f82fc9b54e607ff259d1b83a55cd76af4f528609cd694d8ff4ef91d619a07e6d` downloaded the exact 802,207-byte odyssey archive (sha256 `4d365f7a4678323e5b865bca52b60c47ce5f291fac30cebcb43a941d66da6393`), opened with one legible issue notice, and reopened radio-off after force-stop at saved text offset 476. baseline lacked `scrollend` and saved no position; shared fallback passed on the clean apk. hosted notice and light-reader warning contrast were visually checked | video/x/capture provider outcomes, two exact note indexes, signed physical-device acceptance |

`./scripts/test` passed on the current code after temporary red/green probes were
removed. android clean debug apk compilation and isolated emulator verification passed.
the original checkout and its existing emulator were not changed. release must use one clean merged source sha,
the release owner's verified database backup and no-use window, and a signed
android artifact. old offline packages require redownload; pending progress and
account state stay with the existing store. a code revert cannot undo migration
or exact-item repair; use the verified backup or forward repair.

trade-offs: partial books remain useful but their absent images cannot be
recovered from the original bytes. diagnosed reprocessing is operator-only and
refuses already published epub reader identities. a 10,000-issue/64 mib bound
rejects pathological damaged books rather than truncating evidence. archive
integrity, svg, source hash, queue claim and publication fences stay strict.

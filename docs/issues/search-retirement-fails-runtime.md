# search retirement failure disables the live api's searches

on deployed `4e94db150`, an ordinary firefox search for “tolkien” stopped the
workspace. preview request `871997f2-2bfa-4a40-b634-dc40ad51a171` returned
500/`E_INTERNAL` in 9.46 ms. its saved traceback reaches
`python/nexus/db/engine.py:90`: `search retirement unconfirmed; runtime repair
required`. this request refused before acquiring a connection; it does not
establish the earlier cleanup failure's cause.

the earlier hybrid preview `9ec489f2-4b0d-471b-bbc2-ac2b5688e309` lost its
database connection during canonical indexed retrieval after 2.3 seconds. at
22:35:22.942 utc, postgres killed backend 931; the exact postgres cgroup's kernel
record confirms its 512 mib memory limit was reached, with one oom kill and
319,940 kib anonymous resident memory in the victim. postgres recovered at
22:35:23.420. confirmation had already abandoned its ten-second window after
4.89 ms because the control connection reported recovery mode. no request
deadline expired. the user confirms the full word was entered before the crash.

the failed all-family, unscoped preview differs from the previously measured
document-only library query. on the retained replica, the same canonical owners
generated a representative full-word/all-scope statement with 2,351 plan nodes.
explain without execution reported a fresh backend's resident high-water of
364,880 kib at planning, after an earlier 117,968 kib report. this establishes
substantial pre-execution memory demand; it is total process high-water, not
incremental planner allocation or the production victim's anonymous rss.
original production bound parameters were not retained. no production query
replay or cap increase is selected.

sharing the unchanged capture-authority relation once per statement reduced
replica planning high-water to 260,400 kib. the candidate indexed query completed
in 1.79 seconds with 115 rows and no oom; its cgroup reached the memory cap while
reclaiming. independent reserve, actual recovery and deployed completion remain
unproved. this standalone read is not a whole-host fit claim.

the search capacity owner intentionally withholds capacity after unconfirmed
physical retirement. diagnose and repair the originating cleanup path without
releasing an unconfirmed backend or merely resetting the process. preserve a
truthful request-level failure rather than treating search unavailability as a
workspace defect. private request/retirement records remain with the release owner.

resolve with confirmed physical cleanup after the actual triggering boundary,
safe subsequent search admission, and a useful ordinary deployed search without
a workspace crash. no restart, query replay or timer change has been selected.

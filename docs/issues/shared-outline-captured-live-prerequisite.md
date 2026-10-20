# captured note body verification prerequisite

owner decision, 2026-10-19: accept source review and waive this live witness for
this change. retain the gap for later real citation-producing qualification.

the shared-outline change has no live witness that an ordinal citation showing a
note's captured words stays read only after that same note's current body changes.
this is an acceptance gap, not an observed write-authority defect. source review
alone does not establish browser behavior.

`python/nexus/services/resource_graph/citations.py:52` owns ordinal citation
publication; lines 63–68 create captured `origin="citation"` edges. real publishers
include `python/nexus/services/chat/citations.py:180` (retrieval evidence published
on an assistant message) and `python/nexus/services/oracle/readings.py:341` (a
completed reading). public note/graph commands cannot seed this historical shape.
the canceled user-message fixture does not exercise either publisher. a lawful
fixture needs a successful real citation-producing generation/retrieval journey;
no fake provider, direct database seed, or new test-only writer is acceptable.

resolved when a temporary real journey captures a note citation, changes its
current body through the public owner, opens the captured occurrence, and proves
the old words remain immutable with no lazy current-body activation or body write;
the ordinary current occurrence must remain editable. retain the public ordinal
and captured/current identity evidence in the change's verification report.

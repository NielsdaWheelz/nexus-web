# offline highlights must retain their source publication

target gap: an offline source can remain readable after the server publishes
different text. synchronizing its new annotation must preserve writing without
applying old offsets to a different publication.

evidence: `python/nexus/services/highlights.py:765-777,825-839` checks the current
reading generation and refuses fresh creation with `Reader publication changed`.
`docs/modules/offline.md:23-25` currently excludes annotations from saved views.

impact: replaying today's create request either refuses valid offline authored
work or, if its fence is removed indiscriminately, places it on the wrong text.

resolved when local creation retains exact source identity, quote and anchor;
reconnection after source replacement preserves the annotation and attached
notes; unique valid relocation works and unresolved location remains explicit
at the source without creating a recovery destination.

migration gap: current fragment-anchor/highlight rows do not necessarily retain
their creation generation. never label an old locator with the current generation
without exact quote/extent proof. preserve unknown original publication as null
and resolve by unique quote. resizing and independent overlapping highlight
identities must follow the owner's explicit v1 decision.

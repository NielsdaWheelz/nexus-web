# remaining acquisition caller verification

slice1 merged as `3602fc61a` (#889), but its retained pr report leaves podcast
acquisition after an unrelated library write, model-initiated `nexus.library.add`,
x-thread busy, and Complete rows in Recent unrun. the source census is in the
build's `reports/native-relaunch/acceptance-audit.md:94-128`; it rejects blanket
claims that fake providers make every such state unreachable.

this leaves the changed callers and complete-row selection unqualified by real
journeys. inspect allowed canonical fixtures and ingress first: podcast admission
does not itself need discovery; metadata-free ingress can yield complete rows;
the default model fixture emits no tool calls. resolve with actual permitted
requests/ingress and observed outcomes, or exact source-proved runtime limits
named in the pr under the import spec. do not fabricate provider directory
responses, database statuses, tool execution, or x outcomes.

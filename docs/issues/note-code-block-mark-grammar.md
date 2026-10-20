# code-block marks disagree across the note boundary

the api accepts marked text inside a code block; the browser rejects that body
when reopening it. impact: a valid api write can make its note uneditable.

evidence: `python/nexus/schemas/note_bodies.py:22,86–106` permits code-block text
with any `_MARKS` member. `apps/web/src/lib/notes/noteBody.ts:84–86` forbids those
marks, and `parseBody` calls `block.check()` at line 201. source review only;
no live reproduction yet.

resolve the note grammar at its owning boundary; qualify an actual write/read
round trip and state how any existing incompatible bodies are repaired.

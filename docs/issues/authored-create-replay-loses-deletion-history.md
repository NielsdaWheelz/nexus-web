# authored create replay loses deletion history

status: open · origin: owner source audit, 2026-10-21 · area: notes and highlights api (creation replay)

problem: page, note and highlight creation replay against live rows only. a create
that committed but lost its reply can create again after another session deletes
its result. today the window is the tab FIFO's transport resend (no answer, 429,
502-504 resend the sealed bytes); durable offline replay would lengthen it.

evidence (source at `2e154f053`; source review only, no live mutation):
- `python/nexus/services/notes.py:119-153` (`create_page`) publishes a fresh page
  when the page id is absent; `:199-217` deletes the row physically.
- `python/nexus/services/note_bodies.py:179-195` (`ensure_note`, reached from an
  outline `insert_note` at `services/outline.py:256-262`) creates an absent note id;
  `:239-259` deletes the row physically.
- `python/nexus/services/highlights.py:532-586` (`ensure_highlight`) mints a server
  id and reuses only a live exact extent; `:904-929` deletes the rows.
- `apps/web/src/lib/notes/writes.ts:296-320` resends a sealed request under transport
  doubt.
- `docs/modules/notes.md:126-127` and `docs/modules/highlight.md:135-137` state the
  recreation as current behaviour; `AGENTS.md:21` forbids a replay ledger.

impact: a resent or replayed create cannot promise that a deleted page, note or
highlight stays deleted. client ids prevent duplicate creation only while the
identity evidence (the live row) survives. same shape as
[library-create-replay-depends-on-live-row](library-create-replay-depends-on-live-row.md)
and [chat-admission-replay-outlives-deleted-run](chat-admission-replay-outlives-deleted-run.md).

fix: before durable offline authoring, specify the supported replay lifetime and a
deletion/identity fence that covers it, or explicitly retain this limitation. this
needs an owner decision under the no-replay-ledger rule; do not add a hidden
receipt or compatibility system.

resolved when the supported lost-reply, create, delete, resend sequence cannot
recreate deleted content, or a bounded replay contract refuses work older than its
retained identity evidence.

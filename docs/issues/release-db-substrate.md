# release: db substrate re-slice

status: on branch `cleanup/db-substrate-reslice`; ships in the next backend release.
no migration, no environment change, no wire bump; api and both worker lanes run
from one image, as today. web, android and the extension are unchanged.

data effect: none. the mapping stops restating DDL; the database already owns
every rule it dropped (the two `ON DELETE CASCADE` it misstated were never in the
schema).

before release:

- on the newest production backup brought to the release's head (mac only,
  disposable, deleted after), run the campaign's schema identity check inside the
  branch image (`2026-10-20/db/sketches/identity.py <dsn> models.py retries.py`):
  exit 0. a difference blocks the release. on the same restore, record the census
  C1-C10 (`2026-10-20/db/spec.md` §8); a count off its stated expectation goes to
  the owner (C7 counts JSON `null` where SQL NULL is meant; an ORM `None` in
  `message_retrievals.locator` now stores SQL NULL). the 8a67e218a backup (0292)
  cannot be brought to head by any current tree until 0293 stops importing app
  code (main's 0293 fails on it with `note_blocks.last_activity_at`, under this
  mapping and main's alike), so this waits on that rehearsal.
- 0293: if production is still before 0293 when this ships, 0293's `_convert`
  imports `Media`, `MediaSourceAttempt`, `ProcessingStatus`, `XPostAlias`,
  `XPostSource`, `XThreadPost` and `XThreadSource` from this mapping. their
  columns, types, keys and defaults are unchanged; nothing else about 0293
  changes here. `release-x-thread-imports.md` owns how 0293 runs.

after deploy, the owner's smoke: a text and a pdf highlight, a pdf upload, an
extension capture, a chat in a new conversation, a link between two resources,
an epub. then 24 h of api and worker logs: no `violates foreign key constraint`,
no rise in `exhausted after`.

delete this file once that release is smoked.

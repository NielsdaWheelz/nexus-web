# release: db substrate re-slice

status: merged in #711; ships in the next backend release.
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
  the owner (C7 counts JSON `null` where SQL NULL is meant). c8 includes the four
  mapped-table generated columns plus raw-sql-owned `content_chunks.chunk_text_tsv`.
- c7: 0303 resolves it. it converts the json-null `message_retrievals.locator`
  values (nine in the `8a67e218a` backup) to SQL NULL and narrows the locator check
  to SQL NULL or an object; the chat writer now stores an absent locator as SQL
  NULL. expected 0 after 0303. the 0293 historical-schema blocker is fixed
  independently. 0293 no longer imports this mapping; `release-x-thread-imports.md`
  owns its source repair and cutover.

owed after the release: the release log shows 0303's line
`0303 converts <n> json-null retrieval locators`. the `8a67e218a` backup gives 9;
production's n also counts the locator-less results chats stored since, as json
null until 0303's writer fix.

after deploy, the owner's smoke: a text and a pdf highlight, a pdf upload, an
extension capture, a chat in a new conversation, a link between two resources,
an epub. then 24 h of api and worker logs: no `violates foreign key constraint`,
no rise in `exhausted after`.

delete this file once that release is smoked and its log shows 0303's line.

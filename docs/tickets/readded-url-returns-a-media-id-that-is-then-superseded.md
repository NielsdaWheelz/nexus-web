# re-adding a known web url returns a media id that is then deleted

status: open (harness observation O1, 2026-10-09; reproduced by journeys A2, A4, X2).
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: ingest / source admission.

`POST /media/from_url` for a generic web url that an existing article already
holds answers 202 with a new `media_id`: admission cannot know the final url,
so `_find_reusable_url_media` (`python/nexus/services/media_source_ingest.py:379-407`)
reuses only x and youtube identities. the worker then fetches, finds the holder
of the final url (`web_article._claim_canonical_url`) and supersedes; the new id
answers 404 afterwards. the same holds for a sibling post of an x thread.
clients that open the returned id at once (add panel **Open**, share sheet
**Open in Nexus**) can land on a deleted media.

this is outside the url acquisition slice's call boundary (admission and the
supersession lifecycle belong to `media_source_ingest.py`).

fix: admission reuses a web article whose `canonical_url` equals the normalized
requested url (the common exact re-add), and clients follow
`superseded_by` (or the import's settled media) instead of the first id.

acceptance: re-adding the exact url of an existing article returns that
article's id; a redirecting add's client lands on the holder without a 404.

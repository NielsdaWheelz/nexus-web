# cleanup defaults taken without an explicit owner decision

status: open (owner review) · origin: 2026-10-04 cleanup campaign (claude coordinator) · area: oracle, synapse, chat, offline

these were chosen by the coordinator as reversible defaults and landed; each is recorded here so the owner can confirm or reverse it.

- oracle plates are 36 static files served by the web app (`/oracle-plates/{key}.jpg`) instead of R2 objects; the plate table is gone (#531). one plate's image was corrected (it duplicated another engraving under its own title).
- the oracle corpus is a data file plus one idempotent seed command; the publication marker/reconcile operator protocol is gone (#531).
- consulting the oracle joins the viewer to the corpus library so jumps into corpus works work for every user; corpus highlights stay private (#531).
- oracle readings without a captured plate show current `corpus.json` plate metadata (attribution/dimension drift on 35 of 36 records vs the old rows; production has no plate events).
- connections no longer offer attach PDF/EPUB; upload, then link (#525).
- chat assumptions listed in `docs/modules/chat.md` (assumptions section) and oracle assumptions in `docs/modules/oracle.md`.

acceptance: the owner confirms each, or a follow-up reverses it.

# the Similar lane is calibrated to one embedding model

status: open · origin: 2026-10-04 synapse reauthor (spec D9 residual, branch cleanup/synapse-reauthor) · area: suggestions / semantic index

`python/nexus/services/suggestions.py` pins `_EMBEDDING =
("openai", "openai_text_embedding_3_small_256_v1", 256)` and
`_MIN_SIMILARITY = 0.80`, a human-reviewed calibration for that model. the
rewrite binds the identity in sql (`suggestions._media_neighbor_rows_sql`
anchor state), so other models no longer consume the neighbour limit, but a
configured change of `TRANSCRIPT_EMBEDDING_MODEL_OPENAI` or its dimensions
still yields no Similar evidence at all, silently.

fix: when the embedding model changes, re-calibrate the similarity floor for
the new model and update the pair together; optionally log once when the
active identity differs from the calibrated one.

acceptance: a documented calibration for the active model, and Similar
evidence present on a fixture embedded under it.

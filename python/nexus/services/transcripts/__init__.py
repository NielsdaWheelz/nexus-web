"""Media-level transcript ownership (kind-agnostic).

Owns transcript-version writes and the media_transcript_states table for every
media kind (podcast episodes and videos alike), so there is exactly one locked
writer instead of one copy per ingest path.
"""

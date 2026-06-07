"""Search tuning constants and the retrieval-locator adapter."""

from __future__ import annotations

from pydantic import TypeAdapter

from nexus.schemas.retrieval import RetrievalLocator

RETRIEVAL_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)


# =============================================================================
# Constants
# =============================================================================

# Pagination defaults
DEFAULT_LIMIT = 20


MAX_LIMIT = 50


MIN_QUERY_LENGTH = 2


# Number of candidates to fetch per type before merging
CANDIDATES_PER_TYPE = 200


CONTENT_CHUNK_MIN_ANN_CANDIDATES = 200


CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER = 20


# Cosine similarity must clear a relevance floor; ANN nearest neighbors alone are not matches.
CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY = 0.50


# Maximum snippet length
MAX_SNIPPET_LENGTH = 300

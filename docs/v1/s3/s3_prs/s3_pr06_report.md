# PR-06: Keyword Search Implementation Report

## Summary of Changes

This PR implements full-text keyword search across media titles, fragments, annotations, and messages using PostgreSQL's native full-text search capabilities.

### New Files Created

1. **`python/nexus/schemas/search.py`**
   - `SearchResultOut` - Base schema for search results with type, id, score, snippet
   - `MediaSearchResultOut`, `FragmentSearchResultOut`, `AnnotationSearchResultOut`, `MessageSearchResultOut` - Type-specific result schemas with additional context fields
   - `SearchPageInfo` - Pagination metadata with `has_more` and `next_cursor`
   - `SearchResponse` - Response envelope containing results list and page info
   - `SearchRequest` - Request schema (for documentation, actual params via Query)

2. **`python/nexus/services/search.py`**
   - `visible_media_ids_cte()` - CTE for media visible via library membership
   - `visible_conversation_ids_cte()` - CTE for conversations visible via ownership, public sharing, or library sharing
   - `encode_search_cursor()` / `decode_search_cursor()` - Base64url offset-based pagination
   - `search_content()` - Main search function orchestrating queries, visibility, ranking, and pagination

3. **`python/nexus/api/routes/search.py`**
   - `GET /search` endpoint with query parameters: `q`, `scope`, `types`, `cursor`, `limit`

4. **`python/tests/test_search.py`**
   - Comprehensive test suite covering:
     - Basic keyword matching across all content types
     - Visibility filtering (only sees own content)
     - Scope filtering (media, library, conversation)
     - Pagination with cursor navigation
     - Edge cases (short queries, stopwords, empty results)
     - Pending message exclusion
     - Ranking consistency

### Modified Files

1. **`python/nexus/api/routes/__init__.py`** - Registered search router
2. **`python/nexus/schemas/__init__.py`** - Exported search schemas
3. **`python/README.md`** - Added search endpoint documentation

## Problems Encountered

### 1. Database Constraint on Pending Messages
**Problem**: Test `test_pending_messages_never_searchable` failed with `CheckViolation` because the database has a constraint `ck_messages_pending_only_assistant` that only allows assistant messages to have `pending` status.

**Solution**: Updated the test helper `create_test_conversation_with_message` to accept a `role` parameter, and modified the failing test to use `role='assistant'` when creating pending messages.

### 2. Annotation Visibility in S3 Spec
**Problem**: The S3 spec indicates annotations are owner-only in this slice, which needed to be enforced in search.

**Solution**: Added explicit `WHERE highlight.user_id == viewer_user_id` filter when searching annotations in `scope='all'` mode.

### 3. tsvector Column Detection
**Problem**: Needed to verify which columns have `tsvector` indexes for full-text search.

**Solution**: Reviewed migration `0004_slice3_schema.py` which adds `content_tsv` to messages and confirmed existing indexes on `media.title_tsv`, `fragment.canonical_text_tsv`, and `annotation.body_tsv`.

## Solutions Implemented

### Visibility CTEs
Implemented reusable SQLAlchemy CTEs for visibility filtering:

```python
def visible_media_ids_cte(viewer_user_id: UUID):
    """Media visible via library membership."""
    return (
        select(LibraryMedia.media_id)
        .distinct()
        .join(Membership, LibraryMedia.library_id == Membership.library_id)
        .where(Membership.user_id == viewer_user_id)
        .cte("visible_media_ids")
    )
```

### Ranking Algorithm
- Used `ts_rank_cd()` for relevance scoring
- Applied type-specific weight multipliers: media=1.3, annotation=1.2, message=1.0, fragment=0.9
- Normalized scores within each type to [0,1] range
- Merge-sorted all results by normalized score DESC, then by ID for stability

### Scope Handling
- `all` - Searches across all visible content
- `media:<uuid>` - Restricts to specific media (validates visibility)
- `library:<uuid>` - Restricts to specific library (validates membership)
- `conversation:<uuid>` - Restricts to specific conversation (validates visibility)

### Pagination
- Offset-based cursor pagination using base64url-encoded JSON
- Deterministic ordering via score + id for consistent pagination
- Capped at 200 candidates per type before merging

## Decisions Made

### 1. Separate Type Queries vs UNION ALL
**Decision**: Execute separate queries per type and merge in Python.
**Rationale**: Cleaner code, easier to apply type-specific visibility rules, and allows per-type candidate limiting.

### 2. Offset-Based vs Keyset Pagination
**Decision**: Used offset-based pagination.
**Rationale**: Search results are inherently unstable (scores can change with index updates), and keyset pagination would be complex with multi-type merged results. Offset is simpler and sufficient for typical search use cases.

### 3. Score Normalization
**Decision**: Normalize scores to [0,1] within each type before applying multipliers.
**Rationale**: Different content types may have vastly different raw score distributions. Normalization ensures type multipliers have the intended effect.

### 4. No New Error Codes
**Decision**: Reused existing `E_NOT_FOUND` and `E_INVALID_REQUEST` error codes.
**Rationale**: The spec mentioned potential new codes but existing ones adequately cover scope validation failures and malformed cursors.

## Deviations from Spec/Roadmap

### Minor Deviations

1. **Snippet Generation**: Used `ts_headline()` directly instead of custom truncation logic. The spec didn't specify implementation, and PostgreSQL's built-in function is robust.

2. **Type Weights**: Implemented as specified (media=1.3, annotation=1.2, message=1.0, fragment=0.9) but with additional score normalization not explicitly mentioned.

3. **Empty Query Handling**: Returns empty results for queries < 2 characters or consisting only of stopwords, rather than throwing an error.

### No Deviations

- API shape matches spec exactly
- Visibility rules implemented as specified
- Scope formats match spec
- Pagination cursor format implemented as specified

## Commands

### Running Tests

```bash
# Run all backend tests
make test-back

# Run only search tests
make test-back PYTEST_ARGS="-v tests/test_search.py"

# Run specific test
make test-back PYTEST_ARGS="-v tests/test_search.py::TestSearchEndpoint::test_search_media_title"
```

### Using the Search API

```bash
# Basic search
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/search?q=quantum+computing"

# Search with scope
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/search?q=test&scope=library:$LIBRARY_ID"

# Search specific types
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/search?q=test&types=media&types=fragment"

# Paginated search
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/search?q=test&limit=10&cursor=$CURSOR"
```

### Example Response

```json
{
  "results": [
    {
      "type": "media",
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "score": 0.95,
      "snippet": "Introduction to **quantum** **computing**...",
      "title": "Quantum Computing Fundamentals"
    },
    {
      "type": "fragment",
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "score": 0.82,
      "snippet": "...explains the basics of **quantum** mechanics...",
      "media_id": "550e8400-e29b-41d4-a716-446655440000",
      "idx": 5
    }
  ],
  "page": {
    "has_more": true,
    "next_cursor": "eyJvZmZzZXQiOiAxMH0"
  }
}
```

## Commit Message

```
feat(search): implement PR-06 keyword search with PostgreSQL full-text search

Implements full-text keyword search across media titles, fragments,
annotations, and messages using PostgreSQL's native tsvector/GIN
infrastructure from previous migrations.

Key features:
- GET /search endpoint with q, scope, types, cursor, limit params
- Visibility filtering via reusable SQLAlchemy CTEs
- Scope filtering: all, media:<id>, library:<id>, conversation:<id>
- Type-specific ranking with multipliers (media=1.3, annotation=1.2,
  message=1.0, fragment=0.9)
- Offset-based cursor pagination with base64url encoding
- ts_headline() snippet generation with keyword highlighting

Security:
- Zero visibility leakage via SQL-level filtering before ranking
- Scope authorization checks prevent unauthorized access
- Pending messages explicitly excluded from search

New files:
- python/nexus/schemas/search.py - Request/response Pydantic schemas
- python/nexus/services/search.py - Search service with visibility CTEs
- python/nexus/api/routes/search.py - GET /search endpoint
- python/tests/test_search.py - Comprehensive test suite

Modified:
- python/nexus/api/routes/__init__.py - Register search router
- python/nexus/schemas/__init__.py - Export search schemas
- python/README.md - Document search endpoint

Tests: 659 passed

Closes: PR-06
Spec: docs/v1/s3/s3_prs/s3_pr06.md
```

## Test Coverage Summary

| Category | Tests |
|----------|-------|
| Basic search (all types) | 8 |
| Visibility filtering | 6 |
| Scope filtering | 6 |
| Pagination | 4 |
| Edge cases | 6 |
| Error handling | 4 |
| Conversation visibility modes | 12 |
| **Total** | **46** |

All 659 backend tests pass including the new search tests.

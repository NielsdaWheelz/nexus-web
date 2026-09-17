# models.py mirrors a schema nothing reads

status: open · origin: 2026-09-17 slop sweep (claude session) · area: python db
models · oi-154

the only access path to a model class is an explicit `from nexus.db.models
import X`: `rg -n 'from nexus.db import models|import nexus.db.models|db\.models\.'`
= 0, `rg -n 'Base\.metadata|metadata\.tables|Base\.registry|__subclasses__'` =
0, `rg -n 'create_all'` = 0, and `migrations/alembic/env.py:20` sets
`target_metadata = None`. an AST pass over all 788 non-venv `.py` files yields
93 imported names, and the following are in none of them:

- 33 mapped classes (`MediaUploadEvent`, `MediaProcessingEvent`,
  `ArtifactRevision`, `ArtifactBuildFailure`, `ArtifactBuildCancellation`, the
  seven podcast classes, `ConsumptionActivitySpan`/`Exclusion`/`CompletionFact`,
  `ContentBlock`, `EvidenceSpan`, `ContentChunk`, `ContentChunkPart`,
  `ContentEmbedding`, `MediaAtlasPosition`, the three reader-apparatus classes,
  `MediaClaim`, `PodcastTranscriptRequestAudit`, `LibraryInvitation`,
  `ReaderMediaState`, `ReaderEngagementState`, `ConsumptionOverride` and the
  rest), plus `PGVector` (44-52), whose only user is
  `ContentEmbedding.embedding_vector` (3708);
- 26 `relationship()` declarations with zero attribute access (of which 5 belong
  to the deleted classes). no loader option reaches them either:
  `selectinload|joinedload|subqueryload|contains_eager|lazyload|raiseload|noload|defaultload|with_loader_criteria`
  = 0 hits repo-wide;
- 15 `PyEnum` classes with no consumer in either direction (`MembershipRole`,
  `LibraryInvitationRole`/`Status`, `SharingMode`, `MessageRole`,
  `MessageStatus`, `BranchAnchorKind`, `ContextTargetType`,
  `MessageToolStatus`, `ChatRunStatus`, `ChatRunEventType`,
  `AppSearchResultType`, `AssistantClaimVerifierStatus`,
  `AssistantEvidenceRole`, `RetrievalEvidenceStatus`) — the only `Enum(...)`
  columns in the file are `Media.processing_status` / `failure_stage`;
- every `__table_args__` block in the surviving classes: 211 CheckConstraints,
  74 UniqueConstraints, 77 Indexes, 3 ForeignKeyConstraints, about 2278 lines
  that reach neither the database nor any reader. the two ON CONFLICT sites use
  `index_elements` (`collection_revisions.py:90-134`, `gutenberg.py:122`) and
  the only `__table__` uses take `.c` columns for aliased joins
  (`auth/permissions.py:348-412`, `resource_grants.py:137,170`).

the owner has decided: take the whole cut, not the index-only half.

prerequisite: none for the deletions — every table stays, so no migration.
`ForeignKey()` stays on columns only where a surviving `relationship()` mapping
needs it; the dangling `ForeignKey(...)` arguments on
`SynthesisArtifact.current_revision_id` (2281-2289) and
`MessageRetrieval.evidence_span_id` (5332-5336) are stripped to plain UUID
columns because mapper configuration requires it, not for tidiness — the
constraints stay in the database. dropping a `relationship()` also means
stripping `back_populates` on its 13 surviving partners (1141, 1142, 1499,
1738-1742, 1872-1875, 2010, 3352, 3353, 4697, 6627 and siblings) or SQLAlchemy
errors.

fix: one commit deleting the classes, relationships, enums and `__table_args__`
blocks, and rewriting `docs/architecture.md` §6 and §14 to say models.py holds
only the mapped classes the code queries, with the live database
(`pg_dump --schema-only`) and `migrations/` as the schema of record.

acceptance: `./scripts/test` passes, the api and both worker lanes start, and a
read of each surviving mapped class still works.

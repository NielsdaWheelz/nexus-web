# PDF Highlight Page Number Boundary Hard Cutover

Status: SPECIFICATION
Author: Codex
Type: hard cutover
Date: 2026-06-20

## One-Line

Make PDF highlight `page_number` validity a route-boundary contract everywhere
PDF highlight APIs accept a page locator. The final state rejects every
client-supplied PDF highlight `page_number < 1` before media lookup, service
dispatch, geometry canonicalization, or database access.

No compatibility lane, fallback parser, legacy zero-based interpretation,
client-side normalization, BFF compensation, or service-only acceptance path
survives this cutover.

## North Star

PDF highlight page numbers are user-facing, URL/API-facing, and stored as
1-based document locators.

The product contract is:

```text
PDF highlight locator = (media_id, 1-based page_number, canonical page-space quads)
```

Every API request that supplies a PDF highlight page number must supply a
positive integer under the FastAPI/Pydantic query and body contracts. A zero,
negative number, non-integral query token such as `1.2`, string token that is
not an integer, missing value, or legacy zero-based page index is not a valid
locator. Invalid external input fails closed as `400 E_INVALID_REQUEST`.

The route boundary accepts only the canonical wire shape. The service layer then
answers media-specific questions: whether the media exists, whether the viewer
can read it, whether it is a PDF, whether it is ready for write operations, and
whether the positive page number is within that media's `page_count`.

## SME Thesis

A subject matter expert would not treat this as a PDF.js quirk, a frontend
off-by-one bug, or a database constraint problem. They would ask:

1. Where does untrusted input first enter owned code?
2. Which layer can reject representational invalidity without needing domain
   state?
3. Which layer owns media-dependent validity?
4. Which stored invariant catches corruption if owned code regresses?
5. Which test proves the route boundary rejects the bad input before deeper
   layers can observe it?

The correct answer is:

```text
client / external caller
  -> Next BFF proxy, no business logic
  -> FastAPI route and Pydantic/FastAPI query/body validation
  -> PDF highlight service media and page-count validation
  -> geometry canonicalization
  -> highlight_pdf_anchors storage shape
```

For this repo, the highest-layer production fix is a FastAPI route/query
contract for the remaining list endpoint gap. POST and PATCH body schemas
already reject `page_number < 1`.

The professional move is not to add a second parser in the service, not to
coerce `0` to `1`, not to return an empty highlight list for page zero, and not
to add a frontend guard that hides an invalid backend contract.

## Repo Rules And Precedents

This cutover follows these existing repository rules:

- `docs/rules/boundaries.md`: untrusted API input is parsed, validated, and
  narrowed where it enters. Downstream code receives the narrow representation.
- `docs/rules/errors.md`: malformed external input is an expected typed error;
  broken trusted state is a defect.
- `docs/rules/layers.md`: route/process layers own boundary adaptation;
  services own runtime behavior and domain decisions.
- `docs/rules/database.md`: storage shape belongs in the database; richer
  lifecycle and domain invariants stay in application code.
- `docs/rules/testing.md`: request/response behavior is tested at API
  boundaries; schema and pure validation can use unit tests.
- `docs/architecture.md`: FastAPI routes validate input, call a service, and
  shape responses; Next API routes proxy to backend owners.
- `docs/architecture.md`: PDF highlight locators are `(page_number, geometry
  quads)` plus a match into `media.plain_text`.
- `docs/modules/pdf.md`: `pdf_highlights.py` and related reader services own
  PDF highlight and locator behavior.

Existing patterns to reuse:

- Numeric query constraints use `Query(ge=1, le=...)` directly on FastAPI route
  parameters, for example media, reader document map, libraries, podcasts,
  browse, users, and web search routes.
- Strict body contracts use Pydantic `Field(ge=...)`, `Literal`,
  discriminated unions, validators, and `ConfigDict(extra="forbid")`.
- Manual route parsers are reserved for grammars FastAPI should not coerce,
  such as strict `"true"` / `"false"` query tokens and SSE headers.
- The global `RequestValidationError` handler maps FastAPI/Pydantic validation
  failures into the repo envelope: `400 E_INVALID_REQUEST`.

## Current Head Facts

### Already Correct

- `CreatePdfHighlightRequest.page_number` is declared with
  `Field(..., ge=1)`.
- `PdfAnchorUpdateRequest.page_number` is declared with `Field(..., ge=1)`.
- `PdfBoundsUpdate.page_number` is declared with `Field(..., ge=1)`.
- `POST /media/{media_id}/pdf-highlights` receives
  `CreatePdfHighlightRequest`, so body `page_number < 1` is rejected before the
  handler reaches `pdf_highlights.create_pdf_highlight`.
- `PATCH /highlights/{highlight_id}` receives `UpdateHighlightRequest`, so a
  `pdf_page_geometry` anchor update with `page_number < 1` is rejected before
  service dispatch.
- `pdf_highlights._validate_page_number` rejects missing `page_count`, page
  numbers below 1, and page numbers above `media.page_count`.
- `highlight_pdf_anchors.page_number` is `NOT NULL` and has
  `CHECK (page_number >= 1)`.
- `pdf_page_text_spans.page_number` is a primary-key member and has
  `CHECK (page_number >= 1)`.
- Frontend PDF highlight creation and updates use 1-based `pageNumber`.
- Next routes for PDF highlight APIs are thin proxies.

### Still Wrong

- `GET /media/{media_id}/pdf-highlights` accepts
  `page_number: Annotated[str | None, Query()] = None`.
- The route manually runs `int(page_number)`.
- The route rejects missing and non-integer query values, but does not reject
  `< 1` before service dispatch.
- With a nonexistent `media_id` and `?page_number=0`, current behavior can reach
  media lookup and return the wrong layer's result instead of proving route
  invalidity first.
- The route-boundary contract is weaker than the body contracts for create and
  update.

## Target Behavior

### GET `/media/{media_id}/pdf-highlights`

Final request contract:

```python
page_number: Annotated[
    int,
    Query(ge=1, description="1-based PDF page number"),
]
```

Behavior:

- Missing `page_number` fails at request validation.
- Non-integral `page_number` tokens such as `abc` and `1.2` fail at request
  validation.
- Empty values fail at request validation.
- `page_number=0` fails at request validation.
- `page_number=-1` fails at request validation.
- Valid positive integers enter the route as `int`.
- The route does not manually call `int(...)`.
- The route does not contain a local `_parse_page_number` helper.
- The route delegates exactly one service call:
  `pdf_highlights_service.list_pdf_highlights(..., page_number=page_number, ...)`.
- The response keeps the current success shape:

```json
{
  "data": {
    "page_number": 1,
    "highlights": []
  }
}
```

Invalid request response shape:

```json
{
  "error": {
    "code": "E_INVALID_REQUEST",
    "message": "...",
    "request_id": "..."
  }
}
```

The exact validation message is not a compatibility contract. Tests assert the
status and error code.

### POST `/media/{media_id}/pdf-highlights`

Final request contract remains:

```python
CreatePdfHighlightRequest.page_number: int = Field(
    ...,
    ge=1,
    description="1-based page number",
)
```

Behavior:

- Body `page_number < 1` fails before route handler execution.
- Positive body `page_number` then flows into the PDF highlight service.
- The service still checks media kind, viewer readability, write readiness,
  `media.page_count`, upper bound, geometry validity, duplicate identity, and
  quote-match behavior.

### PATCH `/highlights/{highlight_id}`

Final request contract remains:

```python
PdfAnchorUpdateRequest.page_number: int = Field(
    ...,
    ge=1,
    description="1-based page number",
)
```

Behavior:

- `anchor.type = "pdf_page_geometry"` with `page_number < 1` fails before
  generic highlight update service dispatch.
- Fragment anchor updates remain governed by the existing fragment offset
  schema.
- PDF anchor updates still require `exact`.

### Service Behavior

`pdf_highlights._validate_page_number` remains the service-domain gate for
media-dependent validity:

- `media.page_count is None` -> `400 E_INVALID_REQUEST`.
- `page_number > media.page_count` -> `400 E_INVALID_REQUEST`.
- Internal misuse with `page_number < 1` remains rejected as part of the same
  service invariant until the Python service API has a real `PdfPageNumber`
  value type.

This is not a compatibility fallback. It is the domain service refusing an
invalid internal call. The acceptance tests for external API behavior must prove
that invalid client input is rejected before this service check is needed.

### Database Behavior

No migration is required.

The database remains a storage-shape backstop:

- `highlight_pdf_anchors.page_number >= 1`.
- `pdf_page_text_spans.page_number >= 1`.

The database must not learn `page_number <= media.page_count`. That is a
cross-row, media-domain invariant owned by application code.

## Final Architecture

```text
apps/web/src/app/api/media/[id]/pdf-highlights/route.ts
  proxy only
  no page_number parsing
  no normalization
  no compatibility

python/nexus/api/routes/highlights.py
  route-boundary query contract
  page_number is a positive int by construction
  strict mine_only string parser remains separate

python/nexus/schemas/highlights.py
  PDF write payloads use Pydantic ge=1 body fields
  no zero-based alias or alternate field

python/nexus/services/pdf_highlights.py
  media/kind/readiness/page_count/domain validation
  no HTTP/FastAPI types
  no external query parsing

python/nexus/services/pdf_highlight_geometry.py
  pure geometry canonicalization
  defense against impossible geometry and invalid internal inputs

python/nexus/db/models.py
  storage constraints only
```

## API Design

### Canonical Query Contract

`page_number` is required for the page-scoped PDF highlight list route.

Accepted:

- `?page_number=1`
- `?page_number=2`

Rejected:

- missing `page_number`
- `?page_number=0`
- `?page_number=-1`
- `?page_number=1.2`
- `?page_number=abc`
- `?page_number=`

### Compatibility Policy

No compatibility for:

- zero-based `page_number`;
- `pageIndex`;
- `page_index`;
- non-integral client-supplied floats such as `1.2`;
- string normalization beyond FastAPI's ordinary integer query parsing;
- treating `0` as the first page;
- returning an empty list for invalid pages;
- BFF-side query rewriting.

## Capability Contract

This cutover does not introduce a new user-facing capability field. It tightens
the existing PDF highlight locator capability:

- A PDF media can expose page-scoped highlights only through positive 1-based
  page locators.
- A valid page locator is necessary but not sufficient. The service also
  requires media visibility, PDF kind, available page count, and in-range page.
- Existing saved PDF highlights remain listable even if media processing later
  returns to a non-ready state, matching the current list/read behavior.
- PDF highlight writes still require document readiness through the existing
  service guard.

## Key Decisions

### D1. Use `Query(ge=1)` For The GET Route

This matches existing route-boundary numeric constraints throughout the repo and
keeps OpenAPI accurate. A local parser would duplicate a framework feature and
make the route less declarative.

### D2. Do Not Add A Next/BFF Guard

The BFF route is a proxy. Adding validation there would create a second product
boundary and violate the repo's architecture.

### D3. Do Not Add A New Database Constraint

The positive storage constraint already exists. The remaining route gap is not
a migration problem.

### D4. Keep `mine_only` Manual Parsing Separate

`mine_only` intentionally accepts only the literal strings `"true"` and
`"false"`. FastAPI boolean coercion would widen that grammar. The manual parser
is not precedent for manually parsing integer ranges.

### D5. No Broad Positive-Integer Abstraction

Do not create a generic `PositiveInt` helper. If this implementation touches
the PDF write schemas, a local `PdfPageNumber` Pydantic alias is acceptable
only if it removes the repeated `Field(ge=1, description="1-based page number")`
inside `nexus.schemas.highlights`. The route query should still use a
FastAPI-owned `Query(ge=1)` annotation.

### D6. Tests Prove Layering

At least one new invalid-query test should use a syntactically valid but
nonexistent `media_id`. With `page_number=0`, the route must return
`400 E_INVALID_REQUEST`, not media `404`. That proves validation happened before
service media lookup.

## Duplicate And Similar Patterns To Reuse

Reuse:

- `limit: int = Query(default=..., ge=1, le=...)` patterns in route modules.
- `Annotated[int, Query(ge=1, ...)]` patterns for required numeric query
  bounds.
- Pydantic `Field(ge=1)` for request body page numbers.
- Existing `RequestValidationError` -> `400 E_INVALID_REQUEST` envelope.
- Existing PDF highlight integration test fixture helpers.
- Existing `auth_headers` and `create_test_user_id` helpers.

Do not reuse:

- `_parse_mine_only` for numeric parsing.
- SSE header parsing helpers.
- Service-level `InvalidRequestError` helpers for representational query
  invalidity.
- Frontend runtime guards as proof of backend safety.
- Database check constraints as proof of API behavior.

Potential local consolidation:

- The three PDF write-body schema fields repeat the same page-number constraint.
  If the implementation touches those classes, introduce a local schema alias:

```python
PdfPageNumber = Annotated[
    int,
    Field(ge=1, description="1-based page number"),
]
```

Then use `page_number: PdfPageNumber` in:

- `CreatePdfHighlightRequest`
- `PdfAnchorUpdateRequest`
- `PdfBoundsUpdate`

This is optional for the route-boundary fix. Do not broaden the alias outside
PDF highlight schemas unless another owner explicitly needs the same PDF page
locator contract.

## Files

### Backend Route

- `python/nexus/api/routes/highlights.py`

Required change:

- Replace the raw string query parameter for `list_pdf_highlights`.
- Delete manual `int(...)` conversion.
- Pass the validated integer directly to the service and response payload.

### Backend Schemas

- `python/nexus/schemas/highlights.py`

No required behavior change for the route fix. Optional local consolidation of
PDF write-body page-number fields is allowed if it keeps the contract clearer
and smaller.

### Backend Service

- `python/nexus/services/pdf_highlights.py`

No required behavior change. Service validation remains the media-dependent
domain gate.

### Backend Tests

- `python/tests/test_pdf_highlights_integration.py`
- `python/tests/test_highlight_schemas.py`

Required integration tests:

- `GET /media/{missing_media_id}/pdf-highlights?page_number=0` returns
  `400 E_INVALID_REQUEST`.
- `GET /media/{missing_media_id}/pdf-highlights?page_number=-1` returns
  `400 E_INVALID_REQUEST`.
- `GET /media/{missing_media_id}/pdf-highlights?page_number=abc` returns
  `400 E_INVALID_REQUEST`.

Recommended integration tests:

- Existing missing-query test remains `400 E_INVALID_REQUEST`.
- Existing `page_number > page_count` test asserts `E_INVALID_REQUEST`, not
  only status `400`.
- Existing degenerate geometry test asserts `E_INVALID_REQUEST`, not only status
  `400`.

Recommended schema tests:

- `CreatePdfHighlightRequest(page_number=0, ...)` rejects.
- `PdfAnchorUpdateRequest(page_number=0, ...)` rejects.
- `UpdateHighlightRequest` rejects a PDF anchor update with `page_number=0`.
- Valid page `1` remains accepted.

### Frontend

No required changes.

Relevant files that should remain proxy/consumer-only:

- `apps/web/src/app/api/media/[id]/pdf-highlights/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/route.ts`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/lib/highlights/api.ts`

Do not add frontend normalization for invalid backend input. Existing frontend
guards remain useful UI safety, but they are not the product contract.

### Migrations

No migration.

## Acceptance Criteria

AC1. `GET /media/{media_id}/pdf-highlights` declares `page_number` as an integer
query parameter with `ge=1`.

AC2. The route contains no `int(page_number)` conversion.

AC3. The route contains no `_parse_page_number` helper.

AC4. Missing `page_number` returns `400 E_INVALID_REQUEST`.

AC5. `page_number=0` returns `400 E_INVALID_REQUEST` before media lookup.

AC6. `page_number=-1` returns `400 E_INVALID_REQUEST` before media lookup.

AC7. `page_number=abc` returns `400 E_INVALID_REQUEST` before media lookup.

AC8. `page_number=99` for a readable two-page PDF still returns
`400 E_INVALID_REQUEST` from media-domain validation.

AC9. `page_number=1` for a readable PDF still returns the same success payload.

AC10. POST/PATCH PDF write body contracts still reject `page_number < 1`.

AC11. Existing `mine_only` strict parsing behavior is unchanged.

AC12. No Next `/api` route gains PDF highlight validation or query rewriting.

AC13. No database migration is added.

AC14. No frontend compatibility behavior is added for `page_number=0`,
`pageIndex`, or `page_index`.

AC15. No old API shape or alias is preserved for clients that send zero-based
page values.

## Non-Goals

- No UI redesign.
- No PDF.js runtime refactor.
- No document-map behavior change.
- No search behavior change.
- No vault export behavior change.
- No route count or proxy route change.
- No migration.
- No cleanup of every PDF `page_number` check in unrelated ingestion,
  apparatus, content indexing, or export code.
- No generic positive-integer framework.
- No branded TypeScript page-number type in this cutover.
- No change to `media.page_count` semantics.
- No change to PDF highlight duplicate detection.
- No change to quote matching or geometry canonicalization.

## Implementation Plan

1. Add failing route-boundary tests in
   `python/tests/test_pdf_highlights_integration.py`.
   Use nonexistent media IDs for invalid query values to prove route validation
   runs before service media lookup.

2. Update `list_pdf_highlights` in `python/nexus/api/routes/highlights.py`:

```python
page_number: Annotated[int, Query(ge=1, description="1-based PDF page number")]
```

Delete the `None` branch and `int(...)` conversion.

3. Preserve `_parse_mine_only` exactly unless a dedicated test exposes a
   separate bug.

4. Optionally add schema unit tests in `python/tests/test_highlight_schemas.py`
   for the existing PDF write-body constraints.

5. Optionally consolidate the three body schema page-number fields behind a
   local `PdfPageNumber` alias if the patch touches those classes anyway. Do not
   block the route fix on this refactor.

6. Run focused tests:

```bash
uv run pytest python/tests/test_pdf_highlights_integration.py -q
uv run pytest python/tests/test_highlight_schemas.py -q
```

7. Run a targeted grep gate:

```bash
rg -n "page_number: Annotated\\[str \\| None, Query\\(\\)|int\\(page_number\\)|_parse_page_number" python/nexus/api/routes/highlights.py
```

The grep should produce no matches for the old route parsing pattern.

## Verification Matrix

| Layer | Verification | Expected result |
| --- | --- | --- |
| Route query boundary | GET missing `page_number` | `400 E_INVALID_REQUEST` |
| Route query boundary | GET `page_number=0` with missing media id | `400 E_INVALID_REQUEST`, not `404` |
| Route query boundary | GET `page_number=-1` with missing media id | `400 E_INVALID_REQUEST`, not `404` |
| Route query boundary | GET `page_number=abc` with missing media id | `400 E_INVALID_REQUEST`, not `404` |
| Service domain | GET `page_number=99` for two-page PDF | `400 E_INVALID_REQUEST` |
| Success path | GET `page_number=1` | unchanged success payload |
| Body schema | POST `page_number=0` | `400 E_INVALID_REQUEST` |
| Body schema | PATCH PDF anchor `page_number=0` | `400 E_INVALID_REQUEST` |
| Storage | direct invalid anchor insert | existing DB check rejects |
| BFF | Next API route | unchanged proxy-only behavior |

## Rollback Policy

No compatibility rollback is planned. If the change fails, fix the route
contract or tests. Do not reintroduce raw string query parsing, zero-based
normalization, or BFF fallback behavior.

## Done Means

- The spec has an implementation PR or patch that updates the FastAPI list
  route.
- Focused integration tests prove invalid lower-bound page numbers fail before
  media lookup.
- Existing valid PDF highlight list, create, update, and shared-visibility tests
  still pass.
- Grep shows no remaining manual list-route `page_number` integer parser.
- No frontend, BFF, or database compatibility shim was added.

# Vault Sync Boundary Hard Cutover

## Status

SPECIFICATION.

## Type

Hard cutover. No legacy parser, no compatibility mode, no fallback defaults, no
best-effort coercion, no dual old/new frontmatter contract, no silent no-op
request bodies, and no service-level placeholder values for missing keys.

This is a backend boundary correction for the local Markdown vault sync service.
It does not change the product promise that the vault is an editable projection;
it makes that promise explicit and typed.

## SME Thesis

A subject matter expert would not treat a local Markdown vault file as an
ordinary Python `dict` after it crosses the backend boundary.

The current service has the right product shape but the wrong contract shape:

- the HTTP route validates request bodies with Pydantic;
- the service declares a required-key `VaultFile` typed dict;
- then `sync_vault_files` weakens that contract with `.get(..., "")`;
- frontmatter parsing repeats the same pattern with missing handles, missing
  concurrency tokens, missing selectors, and filename/title fallbacks.

That is not defensive programming. It is unmodeled state. It lets malformed
transport, corrupted exported files, new-file semantics, and valid stale edits
fall through the same string-default branches.

The professional model is:

- parse transport once at the API boundary;
- parse Markdown/frontmatter once at the vault-file boundary;
- represent create/update/delete as a typed union;
- pass typed values into mutation helpers;
- reserve conflict files for valid sync-file failures;
- reserve 400s for malformed HTTP transport;
- reserve defects for internal callers violating typed service contracts.

## Repo Rules and Local Precedents

Rules this cutover implements:

- `docs/rules/boundaries.md`: untrusted input is parsed at ingress into a narrow
  representation; downstream code should not re-validate or recover from states
  the representation rules out.
- `docs/rules/errors.md`: absence that needs classification becomes a typed error
  or a defect, not a raw nullable/optional value passed deeper into the service.
- `docs/rules/cleanliness.md`: parse transport shapes at boundaries, keep raw
  payloads out of service APIs, remove fallback branches, and make illegal states
  unrepresentable.
- `docs/rules/keys-and-identities.md`: canonical handles need validated types and
  parsers; `parseX` may normalize once at ingress, while `assumeX` defects if an
  already-owned value is not canonical.
- `docs/rules/testing.md` and `docs/local-rules/testing_standards.md`: validate
  schema/parser behavior with focused unit tests; validate DB/API behavior through
  public service/API surfaces, not internal mocks.

Patterns to reuse or adapt:

- `services/resource_graph/refs.py`: strict parse failure object plus
  `assert_resource_ref` for already-trusted refs. Vault handles should copy this
  pattern, not use ad hoc `str(... or "")` conversions.
- `schemas/resource_items.py`: discriminated Pydantic input unions for boundary
  variants.
- `schemas/highlights.py`: bounded fields and model validators for semantic
  payload consistency.
- `services/reader.py`: raw body parsing through a `TypeAdapter`, with explicit
  handling of empty body, JSON null, malformed JSON, and invalid payload.
- `services/search/query.py`: transport edge factory that distinguishes omitted
  input from explicitly empty input.
- `api/routes/search.py`: route as thin transport adapter, exactly one service
  call, no domain logic in the route.

## Current State

### HTTP and Browser Boundary

- `apps/web/src/app/api/vault/route.ts` proxies `GET` and `POST` to FastAPI.
- `apps/web/src/app/api/vault/download/route.ts` proxies download to FastAPI.
- `apps/web/src/lib/vault/localVault.ts` reads editable files from `Highlights/`
  and `Pages/`, sends them as `{ path, content }`, then writes returned files,
  deletes, and conflicts.
- Android hides the local vault surface; no Android native vault path exists.

This layer is mostly correct: it is a transport pipe and should remain one.

### FastAPI Boundary

- `python/nexus/schemas/vault.py` defines one `VaultFile` used for both inbound
  editable uploads and outbound snapshot files.
- `VaultFile.path` and `VaultFile.content` are required and `extra="forbid"`.
- `VaultSyncRequest.files` defaults to `[]`, so `{}` silently becomes an empty
  sync request.
- Because `VaultFile` is shared by inbound and outbound payloads, it cannot safely
  validate editable-upload paths. Outbound snapshots include `Library.md`,
  `Media/`, `Sources/`, `Highlights/`, and `Pages/`; inbound sync accepts only
  `Highlights/*.md` and `Pages/*.md`.

The schema needs a split between inbound editable files and outbound projected
files.

### Service Boundary

`python/nexus/services/vault.py` currently declares:

- `VaultFile(TypedDict)` with required `path` and `content`;
- `VaultConflict(VaultFile)` with `message`;
- `VaultSyncResult(TypedDict)` with files/deletes/conflicts.

Then `sync_vault_files` sorts and reads with:

- `item.get("path", "")`;
- `local_file.get("path", "")`;
- `local_file.get("content", "")`.

That silently accepts malformed internal callers and collapses missing content to
an empty Markdown file.

The same issue appears in frontmatter handling:

- missing `highlight_handle` means create highlight;
- missing `page_handle` means create page;
- missing `server_updated_at` becomes a generic stale conflict;
- missing `title` falls back to the filename;
- missing `media_handle`, `selector_kind`, `fragment_handle`, `exact`, and `page`
  collapse into generic invalid-handle or selector behavior.

Some of those states are valid product states, but they are not modeled. New
file, existing exported file, stale file, malformed file, and unsupported edit
need different typed outcomes.

## North Star

The local vault is an editable projection over server-owned resources.

```text
Server truth:
  Media, sources, pages, highlights, note blocks, resource graph edges.

Vault projection:
  Library.md                 read-only projection
  Media/*.md                 read-only projection
  Sources/**                 read-only projection
  Highlights/*.md            editable projection for highlight notes/color/selectors
  Pages/*.md                 editable projection for page title/body/delete
  *.conflict.md              server-written sync failure reports, never input
```

The sync service accepts only editable projection files. It parses each file into
one typed sync command, applies that command through existing owner services, and
exports the fresh projection.

## Target Behavior

### Transport

`POST /vault` requires a JSON object with a present `files` key.

Valid empty sync:

```json
{ "files": [] }
```

Invalid request:

```json
{}
```

The invalid request returns `400 E_INVALID_REQUEST`. It is not a no-op sync.

Every inbound file has:

- `path`: non-empty string, max 500 chars, canonical editable vault path;
- `content`: string, max 1,000,000 UTF-8 bytes.

Inbound paths are accepted only when they match:

- `Highlights/<filename>.md`;
- `Pages/<filename>.md`.

Inbound paths reject:

- absolute paths;
- backslash paths after normalization;
- `..`;
- nested subdirectories under `Highlights/` or `Pages/`;
- `*.conflict.md`;
- non-Markdown extensions;
- `Library.md`, `Media/**`, and `Sources/**`.

### Per-File Sync Outcomes

Each valid inbound file path produces exactly one of these outcomes:

- applied mutation;
- no-op because the typed command matches current server state;
- conflict entry because file content is well-formed but cannot be applied;
- conflict entry because file frontmatter is malformed for the vault contract.

Malformed HTTP transport is a request error. Malformed file content is a file
conflict. Internal service calls that bypass the typed API are defects or typed
invalid-request failures at the service boundary.

### Response

The response shape remains product-compatible for the current frontend:

```json
{
  "files": [{ "path": "Library.md", "content": "..." }],
  "delete_paths": ["Pages/old--page_<id>.md"],
  "conflicts": [
    {
      "path": "Pages/broken.conflict.md",
      "message": "Vault page metadata is missing title",
      "content": "..."
    }
  ]
}
```

Internally, the response schema is split from the request schema. Outbound files
are projected vault files; inbound files are editable sync files. They share a
JSON shape by coincidence, not by contract.

### Frontmatter

Frontmatter is a strict server-owned wire format. The backend writes the canonical
form and accepts only that form plus the explicit new-file forms defined below.

No unknown frontmatter fields. No implicit defaults. No `or ""` coercions.

#### Existing Highlight File

Path:

```text
Highlights/hl_<highlight_uuid_hex>.md
```

Required frontmatter:

```yaml
nexus_type: "highlight"
highlight_handle: "hl_<highlight_uuid_hex>"
media_handle: "med_<media_uuid_hex>"
color: "yellow"
server_updated_at: "<iso datetime>"
deleted: false
exact: "<string>"
prefix: "<string>"
suffix: "<string>"
selector_kind: "fragment_offsets" | "pdf_page_geometry"
```

For `fragment_offsets`, also required:

```yaml
fragment_handle: "frag_<fragment_uuid_hex>"
start_offset: <int>
end_offset: <int>
```

For `pdf_page_geometry`, also required:

```yaml
page: <int>
```

Rules:

- `highlight_handle` must match the handle encoded in the path.
- `server_updated_at` is required for update and delete.
- Missing `server_updated_at` is malformed metadata, not a stale conflict.
- A stale but well-formed `server_updated_at` produces the existing conflict:
  server highlight changed since export.
- `deleted: true` deletes the highlight.
- Fragment selector changes are allowed only through complete typed
  `fragment_offsets` metadata.
- PDF selector edits remain prohibited; malformed PDF selector metadata is not
  reported as an attempted selector edit.

#### New Highlight File

Path:

```text
Highlights/<any-non-conflict-name>.md
```

Required frontmatter:

```yaml
nexus_type: "highlight"
media_handle: "med_<media_uuid_hex>"
color: "yellow"
deleted: false
selector_kind: "fragment_offsets"
fragment_handle: "frag_<fragment_uuid_hex>"
start_offset: <int>
end_offset: <int>
```

Rules:

- `highlight_handle` must be absent.
- `server_updated_at` must be absent.
- `deleted` must be `false`.
- `color` is required. The service no longer defaults to yellow.
- PDF highlight creation from vault remains unsupported.
- The selected fragment must belong to readable media and offsets must be valid.

#### Existing Page File

Path:

```text
Pages/<slug>--page_<page_uuid_hex>.md
```

Required frontmatter:

```yaml
nexus_type: "page"
page_handle: "page_<page_uuid_hex>"
title: "<nonblank string>"
server_updated_at: "<iso datetime>"
deleted: false
```

Rules:

- `page_handle` must match the handle encoded in the path.
- `title` is required. The filename is not a title fallback.
- `server_updated_at` is required for update and delete.
- Missing `server_updated_at` is malformed metadata, not a stale conflict.
- A stale but well-formed `server_updated_at` produces the existing conflict:
  server page changed since export.
- `deleted: true` deletes the page.

#### New Page File

Path:

```text
Pages/<any-non-conflict-name>.md
```

Required frontmatter:

```yaml
nexus_type: "page"
title: "<nonblank string>"
deleted: false
```

Rules:

- `page_handle` must be absent.
- `server_updated_at` must be absent.
- `deleted` must be `false`.
- `title` is required. The filename is not a title fallback.

## Architecture and Final Structure

### API Schemas

`python/nexus/schemas/vault.py` becomes the HTTP schema owner:

- `VaultEditableFileIn`
  - inbound sync file;
  - editable-path validator;
  - UTF-8 byte-size validator;
  - `extra="forbid"`.
- `VaultSyncRequest`
  - `files: list[VaultEditableFileIn] = Field(..., max_length=5000)`;
  - no default factory.
- `VaultProjectedFileOut`
  - outbound projected file;
  - does not reuse editable-path validation because snapshots include
    `Library.md`, `Media/`, and `Sources/`.
- `VaultConflictOut`
  - outbound conflict file.
- `VaultSnapshotOut`
  - projected files, delete paths, conflicts.

The current single `VaultFile` schema is deleted or renamed so inbound and
outbound contracts cannot be accidentally coupled again.

### Service DTOs and Parser

Add a vault-owned parser layer. Acceptable placements:

- preferred: `python/nexus/services/vault_contracts.py`;
- acceptable if kept small: private parser section inside `vault.py`.

Because `vault.py` already mixes export, sync orchestration, frontmatter parsing,
mutation application, Markdown rendering, filesystem sync, and source-file
writing, a separate `vault_contracts.py` is the cleaner target.

The parser layer owns:

- editable path normalization and parsing;
- vault handle parse/format helpers;
- frontmatter parse errors;
- Pydantic or dataclass typed metadata models;
- typed sync-file union;
- conflict-safe conversion from raw Markdown to typed command.

Target types:

```python
@dataclass(frozen=True, slots=True)
class EditableVaultFile:
    path: EditableVaultPath
    content: str

@dataclass(frozen=True, slots=True)
class VaultHandle:
    kind: Literal["media", "fragment", "highlight", "page"]
    id: UUID

@dataclass(frozen=True, slots=True)
class VaultHandleParseFailure:
    raw: str
    expected_prefix: Literal["med", "frag", "hl", "page"]
    reason: Literal["missing", "invalid_format", "wrong_prefix"]

ParsedVaultFile = (
    NewHighlightFile
    | ExistingHighlightFile
    | NewPageFile
    | ExistingPageFile
)
```

Naming follows the repo's `parseX`/`assertX` split:

- `parse_vault_handle(raw, expected_prefix) -> VaultHandle | VaultHandleParseFailure`;
- `assert_vault_handle(raw, expected_prefix) -> VaultHandle` for server-generated
  values only, with `justify-defect`;
- `parse_editable_vault_path(raw) -> EditableVaultPath | failure`;
- `parse_vault_markdown_file(file: EditableVaultFile) -> ParsedVaultFile | VaultFileParseFailure`.

Do not use `ResourceRef` as the handle type. Vault handles are outward projection
handles (`hl_...`, `page_...`), not canonical `ResourceRef` URIs.

### Service Public Contract

`python/nexus/services/vault.py` exposes a narrow semantic interface:

```python
def export_vault_files(db: Session, viewer_id: UUID) -> list[VaultProjectedFileOut]

def sync_vault_files(
    db: Session,
    viewer_id: UUID,
    local_files: Sequence[EditableVaultFile],
) -> VaultSyncResult
```

or the equivalent dataclass return type.

No raw `dict` access in the service public sync path. No service `VaultFile`
`TypedDict` duplicate if the schema or DTO already owns the shape.

The filesystem helper `sync_vault` must construct `EditableVaultFile` through the
same parser/factory used by the API path. There is one inbound editable-file
contract.

### Mutation Helpers

Current mutation helpers remain the behavioral owners, but their parameters
become typed:

- `_sync_highlight_content(db, viewer_id, parsed: NewHighlightFile | ExistingHighlightFile, body)`
- `_create_highlight_from_file(db, viewer_id, parsed: NewHighlightFile, body)`
- `_apply_highlight_changes(db, viewer_id, highlight, parsed: ExistingHighlightFile, body)`
- `_sync_page_content(db, viewer_id, parsed: NewPageFile | ExistingPageFile, body)`

They no longer read `metadata.get(...)`.

Existing downstream composition remains:

- media visibility via `can_read_media`;
- highlight range validation via `validate_offsets_or_400`;
- highlight integrity mapping via `map_integrity_error`;
- note body writes via `notes_service`;
- page adjacency via `graph_adjacency`;
- resource versions via `versions`;
- note reindexing via `enqueue_note_reindex`;
- deletion cleanup via `delete_edges_for_deleted_resource`.

This cutover does not re-own those systems.

### Error Model

The sync stack has three error classes:

1. HTTP request validation errors:
   - malformed JSON;
   - missing `files`;
   - inbound file path outside editable contract;
   - content over byte limit;
   - wrong field type or unknown request field.
   - Result: `400 E_INVALID_REQUEST`.

2. File-level conflicts:
   - malformed frontmatter;
   - missing required metadata;
   - handle/path mismatch;
   - stale server timestamp;
   - unsupported PDF highlight creation;
   - duplicate highlight range;
   - page/block marker mismatch.
   - Result: conflict entry, no mutation for that file.

3. Defects:
   - already-typed server-generated handles fail to parse;
   - exported rows lack invariants required to render canonical frontmatter;
   - internal caller bypasses the public typed contract.
   - Result: fail loud; do not produce placeholder output.

## Key Decisions

D1. Split inbound and outbound vault file schemas.

The same JSON shape does not mean the same contract. Inbound files are editable
uploads; outbound files are server projections.

D2. `files` is required on `POST /vault`.

`{}` is not a sync request. A deliberate empty sync is `{ "files": [] }`.

D3. Path validation moves to the inbound schema/factory.

The service may keep a parser for non-HTTP callers, but path invalidity cannot
be hidden by `.get("path", "")`.

D4. Content size is measured in UTF-8 bytes.

Pydantic `max_length` is not enough because it counts characters. The validator
must check `len(content.encode("utf-8"))`.

D5. Frontmatter is a typed union.

The service does not infer command kind from missing strings. It parses one of
four command variants: new highlight, existing highlight, new page, existing
page.

D6. New-file semantics are explicit.

Omitting a handle is valid only in the new-file variants. It is not valid for an
exported handle-bearing path.

D7. Filename is not a title fallback.

New and existing pages require `title`. The filename is storage affordance only.

D8. Missing `server_updated_at` is malformed metadata.

Staleness requires a well-formed timestamp that differs from server state.

D9. Existing handles must match path handles.

An existing highlight/page file cannot claim a different handle in frontmatter
than the handle encoded in its path.

D10. No PyYAML dependency.

The vault frontmatter grammar is the server's own small wire format. If the
current parser remains, it must become strict and typed. Do not add a broad YAML
grammar that accepts alternate forms "for convenience".

D11. The BFF remains a proxy.

No Next.js-side validation, canonicalization, fallback, or business logic.

D12. Keep per-file conflicts as product behavior.

Strict does not mean one bad local file aborts the whole sync after transport
validation. A valid request carrying an invalid editable Markdown file should
return a conflict file so the user can inspect and fix it.

## Duplicate and Repetitive Patterns to Remove

### Duplicate `VaultFile`

Current:

- `nexus.schemas.vault.VaultFile` as Pydantic API schema;
- `nexus.services.vault.VaultFile` as service `TypedDict`;
- frontend `VaultFile` interface for both upload and download.

Target:

- Python inbound schema: `VaultEditableFileIn`;
- Python outbound schema: `VaultProjectedFileOut`;
- Python internal DTO: either reuse inbound schema models or use one named
  `EditableVaultFile` dataclass created at ingress;
- TypeScript inbound type: `EditableVaultFile`;
- TypeScript outbound type: `VaultProjectedFile`.

No single generic `VaultFile` across all meanings.

### Repeated Empty-String Fallbacks

Delete these patterns from `python/nexus/services/vault.py`:

- `local_file.get("path", "")`;
- `local_file.get("content", "")`;
- `metadata.get("...") or ""`;
- `str(metadata.get("...") or "")` for required frontmatter;
- `metadata.get("title") or fallback_title`;
- `metadata.get("color") or "yellow"` for new highlight input;
- `metadata.get("exact") or ""` where exact is required by an existing PDF
  highlight file.

Optional fields must be represented as optional fields on a typed variant. They
must not be discovered by truthiness.

### Handle Parser Duplication

Current handle helpers format and parse four handle families in one loose
`_parse_handle`.

Target:

- one vault-owned handle parser with typed failure;
- one formatter per handle kind or one typed formatter;
- path-handle extraction uses the same handle parser;
- server-generated handles use `assert_vault_handle` only at trusted points.

### Request/Response Path Contract Coupling

Current `VaultFile.path` cannot become strict without breaking outbound
snapshots. The schema split deletes this hidden coupling.

## Scope

In scope:

- vault HTTP schemas;
- vault API route conversion;
- vault service sync inputs;
- vault frontmatter parser;
- vault handle parser;
- local filesystem `sync_vault` construction of editable input files;
- frontend TypeScript vault types if names are split;
- tests for schema, parser, API, service, and conflicts;
- Pyright include-list update for `nexus/services/vault.py` and any new vault
  parser module.

Out of scope:

- changing the local vault UI;
- adding a new vault file format;
- changing export layout names;
- adding YAML dependency or broad YAML compatibility;
- changing storage schema or migrations;
- changing note/page/resource graph ownership;
- changing Android shell behavior;
- adding bidirectional sync for `Media/`, `Sources/`, or `Library.md`;
- preserving old malformed local files.

## File Plan

### Backend

- `python/nexus/schemas/vault.py`
  - split inbound/outbound schemas;
  - make `VaultSyncRequest.files` required;
  - add editable path and byte-size validators.

- `python/nexus/api/routes/vault.py`
  - keep route thin;
  - pass typed inbound files to the service without rebuilding raw dicts;
  - build outbound response with `VaultProjectedFileOut` and `VaultConflictOut`.

- `python/nexus/services/vault_contracts.py` (new, preferred)
  - editable path parser;
  - handle parser/formatter;
  - frontmatter parser;
  - typed parsed-file union;
  - parse failure types and messages.

- `python/nexus/services/vault.py`
  - delete service `VaultFile` `TypedDict` duplicate;
  - accept typed editable files;
  - remove `.get(..., "")` and truthiness defaults;
  - route each parsed file variant to typed mutation helpers;
  - preserve export and filesystem behavior through typed outputs.

- `python/pyproject.toml`
  - include `nexus/services/vault.py`;
  - include `nexus/services/vault_contracts.py` if created.

### Frontend

- `apps/web/src/lib/vault/localVault.ts`
  - split local interfaces into inbound editable file and outbound projected
    payload file names;
  - no new validation beyond browser file enumeration;
  - continue ignoring `*.conflict.md` as input.

- `apps/web/src/app/api/vault/route.ts`
  - no behavioral change; remains proxy.

- `apps/web/src/app/api/vault/download/route.ts`
  - no behavioral change; remains proxy.

### Tests

- `python/tests/test_vault_schemas.py`
  - missing `files` rejected;
  - missing file `path` rejected;
  - missing file `content` rejected;
  - extra fields rejected;
  - editable path rejects `Library.md`, `Media/**`, `Sources/**`,
    `*.conflict.md`, nested paths, absolute paths, and traversal;
  - content byte limit is UTF-8 byte based.

- `python/tests/test_vault.py`
  - valid empty sync `{ "files": [] }` succeeds;
  - `{}` POST returns `400 E_INVALID_REQUEST`;
  - malformed frontmatter returns conflict, not mutation;
  - missing title in new page returns conflict, not filename fallback;
  - missing color in new highlight returns conflict, not yellow fallback;
  - missing `server_updated_at` in existing page/highlight returns malformed
    metadata conflict;
  - stale `server_updated_at` still returns stale conflict;
  - handle/path mismatch returns conflict;
  - existing page title/body update still works;
  - existing highlight color/note update still works;
  - new page and new fragment highlight still work with full frontmatter;
  - PDF highlight creation still conflicts;
  - multi-block page and multi-note highlight marker tests still pass.

- `python/tests/test_resource_graph_refs.py` is not modified, but its
  parse/failure style is the pattern for vault handle tests.

- New optional unit test file:
  - `python/tests/test_vault_contracts.py`
  - pure parser tests without DB or filesystem.

## Acceptance Criteria

AC1. No silent file-field fallbacks.

`python/nexus/services/vault.py` contains no `local_file.get`, no
`item.get("path", "")`, and no conversion of missing file content to `""`.

AC2. No silent required-frontmatter fallbacks.

Required frontmatter fields are accessed through typed parsed variants. The
service no longer uses `metadata.get("required_field") or ""` or
`metadata.get("title") or fallback_title`.

AC3. Request body `{}` is invalid.

`POST /vault` with `{}` returns `400 E_INVALID_REQUEST`.

AC4. Empty sync is explicit.

`POST /vault` with `{ "files": [] }` succeeds and returns the normal snapshot.

AC5. Inbound/outbound schema split exists.

The inbound editable-file schema cannot validate outbound snapshot paths, and
the outbound snapshot-file schema is not used for sync uploads.

AC6. Existing exported files require concurrency tokens.

Removing `server_updated_at` from an existing page or highlight creates a
malformed metadata conflict. It is not reported as server staleness.

AC7. Stale files still conflict.

A well-formed but stale `server_updated_at` returns the existing stale conflict
message and does not mutate the DB.

AC8. New files are explicit.

New page and new highlight files require all fields in their create variants.
Filename fallback title and default highlight color are gone.

AC9. Path/handle mismatch fails closed.

If a path encodes `page_A` or `hl_A` and frontmatter claims `page_B` or `hl_B`,
the file conflicts and no mutation occurs.

AC10. Existing happy paths remain.

Existing tests for highlight update, multi-note highlight markers, fragment
highlight create, PDF highlight conflict, and page create/update/delete pass
after updating fixtures to full explicit metadata where needed.

AC11. Type baseline includes vault sync code.

`make type-back` checks `nexus/services/vault.py` and any new vault contract
module.

AC12. Negative grep gates pass.

These commands produce no matches except explicitly documented non-required
optional fields:

```bash
rg -n 'local_file\\.get|item\\.get\\("path",\\s*""\\)' python/nexus/services/vault.py
rg -n 'metadata\\.get\\([^\\n]*(?:or\\s*""|,\\s*"")' python/nexus/services/vault.py
rg -n 'fallback_title|or "yellow"|or highlight\\.color' python/nexus/services/vault.py
```

AC13. No BFF business logic.

The Next vault routes still proxy only.

AC14. No legacy compatibility.

There is no branch accepting old missing-title pages, missing-color highlights,
missing `files`, or missing existing-file timestamps as valid.

## Verification Plan

Targeted local gates:

```bash
cd python && uv run pytest -q tests/test_vault_schemas.py tests/test_vault_contracts.py tests/test_vault.py
cd python && uv run ruff check nexus/schemas/vault.py nexus/api/routes/vault.py nexus/services/vault.py tests/test_vault_schemas.py tests/test_vault.py
cd python && uv run ruff format --check nexus/schemas/vault.py nexus/api/routes/vault.py nexus/services/vault.py tests/test_vault_schemas.py tests/test_vault.py
make type-back
```

If no separate `test_vault_contracts.py` is created, omit it from the pytest
command and keep parser coverage in `test_vault_schemas.py` or `test_vault.py`
according to whether the parser is pure or DB-backed.

Browser/UI gates are not required for this backend boundary cutover unless the
frontend TypeScript interface split causes typecheck failures. If touched:

```bash
bun run typecheck
```

## Implementation Order

1. Add pure parser/schema tests first.
2. Split `schemas/vault.py` into inbound and outbound file contracts.
3. Make `files` required on `VaultSyncRequest`.
4. Introduce `vault_contracts.py` with editable path, handle, frontmatter, and
   parsed-file union.
5. Update `api/routes/vault.py` to pass typed files and return outbound schemas.
6. Update `sync_vault` filesystem path to construct the same typed editable files.
7. Update `sync_vault_files` to parse each file once, then dispatch on typed
   variants.
8. Update page/highlight mutation helpers to take typed variants, not raw
   metadata dicts.
9. Delete duplicate `VaultFile` `TypedDict` and fallback code.
10. Update tests for explicit metadata.
11. Add `vault.py` and any new parser module to Pyright include list.
12. Run targeted gates and negative greps.

## Rollout Semantics

This is a hard cutover inside one-user prototype constraints:

- no data migration;
- no database migration;
- no compatibility branch;
- no attempt to auto-repair malformed local files;
- no old-client support.

After deployment, old local files missing required frontmatter fields will produce
conflict files. The server response still includes the fresh canonical projection,
so the local vault can converge by writing the returned canonical files.

## Composition With Other Systems

### Notes and Pages

Page mutations continue through existing page/note services and graph adjacency.
This cutover changes how vault input is accepted, not who owns page body storage,
ordered adjacency, or note reindexing.

### Highlights

Highlight create/update/delete continues through existing highlight models and
validation. The cutover only requires a complete selector command before calling
highlight mutation code.

### Resource Graph

Vault page body sync continues to produce/update graph-backed note blocks and
ordered adjacency through `graph_adjacency`. This cutover does not introduce a
new graph writer.

### Search and Indexing

Existing note reindex enqueue calls remain. The cutover does not change semantic
search, content chunks, or evidence spans.

### Storage

Source-file export and local filesystem write/read helpers remain in vault
ownership. The sync input path ignores `Sources/`, `Media/`, and `Library.md` as
before, but the API boundary now rejects attempts to upload them.

### Frontend

The frontend continues to:

- read editable local files;
- call `/api/vault`;
- write returned files;
- delete returned paths;
- write conflict files.

The frontend does not learn backend validation semantics beyond renamed local
types.

### BFF and Auth

The Next BFF remains a proxy. FastAPI remains the validation and service boundary.
Authentication remains `get_viewer` on FastAPI routes.

## Non-Goals

- No old frontmatter compatibility.
- No support for editing `Library.md`, `Media/`, or `Sources/`.
- No lossy coercion of malformed metadata.
- No automatic title inference from filenames.
- No automatic color defaults for new highlights.
- No PDF highlight creation through vault.
- No new client UX for constructing new vault files.
- No generic Markdown import feature.
- No broad YAML parser.
- No migration of existing local directories.

## Open Implementation Details

These are engineering choices, not unresolved product behavior:

- Whether parsed frontmatter models live in Pydantic models or frozen dataclasses.
  Pydantic `TypeAdapter` is preferred for strict dict validation; dataclasses are
  preferred after validation for mutation helper inputs.
- Whether `vault_contracts.py` returns failure objects or raises
  `InvalidRequestError` for pure parser failures. For per-file conflict behavior,
  returning failure objects is usually cleaner because the sync loop can produce
  conflict entries without exception control flow.
- Whether outbound schema class names use `Out` suffix consistently with the rest
  of `schemas/`.

None of these choices may reintroduce fallback defaults or raw dict access in the
service mutation path.

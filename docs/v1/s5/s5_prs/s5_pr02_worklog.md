# s5 pr-02 worklog

## purpose
Capture bounded-context evidence gathered while authoring `docs/v1/s5/s5_prs/s5_pr02.md`.

## acceptance checklist (source: `docs/v1/s5/s5_roadmap.md`)
- [x] EPUB extraction materializes contiguous chapter fragments in spine order and generates fragment blocks from immutable canonical text.
- [x] TOC snapshot persistence is deterministic and supports stable chapter linkage semantics.
- [x] Title resolution follows deterministic fallback order.
- [x] Resource rewriting follows safe resolution rules; resolved internal assets are served via canonical safe fetch path; unresolved assets degrade without blocking readable output.
- [x] Archive safety controls are enforced and unsafe archives fail deterministically with `E_ARCHIVE_UNSAFE`.

## evidence log

| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | PR-02 scope contract | `docs/v1/s5/s5_roadmap.md` | 85-99 | PR-02 acceptance bullets are extraction artifacts only; ingest/retry and read APIs are explicit non-goals. | Locked singular PR-02 goal and non-goals against PR-03/PR-04 leakage. |
| e-002 | Ownership boundary C3 vs C4 | `docs/v1/s5/s5_roadmap_ownership.md` | 18-19 | C3 owns extraction artifacts; C4 owns lifecycle orchestration and cleanup/reset behavior exposure. | Locked explicit extraction-executor vs orchestration split in deliverables/decisions. |
| e-003 | Normative chapter/TOC extraction semantics | `docs/v1/s5/s5_spec.md` | 84-148 | Spine-order fragment generation, readable-item filtering, TOC deterministic order-key/node semantics, empty TOC non-fatal behavior. | Drove chapter contiguity, TOC determinism, and empty-TOC acceptance tests. |
| e-004 | Resource rewrite + degradation contract | `docs/v1/s5/s5_spec.md` | 231-241 | Internal resource rewrite requirement, external image proxy rewrite, unresolved asset degradation, active-content stripping. | Drove resource rewrite deliverables and degradation-focused acceptance test. |
| e-005 | Title fallback contract | `docs/v1/s5/s5_spec.md` | 243-264 | Deterministic title fallback order and normalization/truncation/lifecycle rules. | Drove title persistence behavior and explicit fallback test cases. |
| e-006 | Archive safety contract | `docs/v1/s5/s5_spec.md` | 265-283 | Path traversal/size/ratio/time safety limits and `E_ARCHIVE_UNSAFE` classification. | Locked hard-gate archive validation with deterministic failure assertions. |
| e-007 | Invariant set for PR-02 ownership | `docs/v1/s5/s5_spec.md` | 648-664 | Invariants 6.1-6.3, 6.12, 6.15, 6.17 include immutability, contiguity, TOC immutability, title determinism, archive safety, and canonical asset fetch safety. | Anchored PR-02 artifact persistence, resource safety, and failure/atomicity requirements. |
| e-008 | Existing extraction architecture seam | `python/nexus/tasks/ingest_web_article.py` | 38-43, 105-223, 360-374 | Existing pattern uses task wrapper + sync helper + service pipeline for extraction behaviors. | Reused architecture shape for `ingest_epub` + sync helper without endpoint coupling. |
| e-009 | Existing reusable primitives | `python/nexus/services/sanitize_html.py`; `python/nexus/services/canonicalize.py`; `python/nexus/services/fragment_blocks.py` | 86; 69; 45-167 | Sanitization, canonicalization, and fragment-block generation are already implemented and tested primitives. | Required reuse in PR-02 to avoid duplicate logic and contract drift. |
| e-010 | Current upload-confirm baseline (no extraction orchestration yet) | `python/nexus/services/upload.py`; `python/nexus/api/routes/media.py`; `python/nexus/schemas/media.py` | 230-434; 190-212; 89-94 | Ingest currently returns `{media_id, duplicate}` and does not expose extraction dispatch/status contract yet. | Enforced PR-02 non-goal: no `/ingest` response semantics changes (owned by PR-03). |
| e-011 | PR-01 merged schema/error primitives available | `python/nexus/db/models.py`; `python/nexus/errors.py` | 1234-1291; 93-96,183-186 | `EpubTocNode` schema and S5 error codes exist and are mapped. | Confirmed PR-02 can consume these primitives without redefining them. |
| e-012 | Legacy EPUB lessons (filtered) | `docs/old-documents-specs/EPUB_SPEC.md` | 35-56, 211-254, 287-320 | Historical pain points: missing chapter boundaries, unresolved asset behavior, title fallback drift, whole-book rendering issues. | Informed deterministic chapter/TOC/resource/title decisions while rejecting legacy incompatible architecture. |
| e-013 | Config baseline for EPUB archive policy | `python/nexus/config.py` | 73-76 | Existing config already centralizes file-size limits; no archive-specific safety config keys exist yet. | Drove PR-02 decision to add explicit archive-safety settings with L2 default floors and validator enforcement. |
| e-014 | Parser dependency baseline | `python/pyproject.toml`; `python/uv.lock` | 1-58; lock entry for `lxml` | `lxml` already exists as a first-class dependency; no EPUB framework dependency is present. | Drove PR-02 decision to use internal `zipfile` + `lxml` parser flow and avoid new parser dependency introduction. |
| e-015 | Canonical resource fetch path gap | `docs/v1/s5/s5_spec.md` | 231-241 (pre-fix) | Resource rewrite required safe fetch paths but lacked explicit canonical endpoint contract. | Drove PR-02 decision to own and implement `/media/{id}/assets/{asset_key}` retrieval contract in C3 scope. |
| e-016 | Storage and media route baseline for binary fetch surfaces | `python/nexus/storage/client.py`; `python/nexus/api/routes/media.py`; `python/tests/test_route_structure.py` | 1-120; 1-235; 1-190 | Storage client supports streaming/signing abstractions; media router already handles binary route (`/media/image`) under transport-only constraints. | Confirmed feasible implementation pattern for EPUB asset binary route without violating route-structure rules. |
| e-017 | Extraction error taxonomy baseline | `docs/v1/s5/s5_spec.md`; `python/nexus/errors.py` | 585-606; 93-100,183-189 | L2 already defines `E_ARCHIVE_UNSAFE`, `E_SANITIZATION_FAILED`, `E_INGEST_FAILED`; errors module contains stable mappings. | Drove PR-02 explicit failure classification matrix to prevent downstream orchestration drift. |

## notes
- Phase 1 skeleton prepared first for PR-02 spec/decisions/worklog package.
- Phase 2 acceptance-cluster micro-loop completed across all five PR-02 acceptance bullets.
- Explicit approvals captured during authoring:
  - Python-native extractor architecture (no Node EPUB subprocess).
  - C3/C4 ownership boundary (artifact executor vs lifecycle orchestration).
  - Deterministic TOC `node_id` parse-path identity strategy.
  - Archive-safety settings centralization with L2 minimum-floor enforcement.
  - Internal parser strategy (`zipfile` + `lxml`) with no external EPUB framework dependency in PR-02.
  - Canonical internal asset route contract (`/media/{id}/assets/{asset_key}`) owned by PR-02.
- Hardening pass completed:
  - roadmap completeness: every PR-02 acceptance bullet mapped to deliverables/tests.
  - dependency sanity: only PR-01 primitives referenced.
  - boundary cleanup: no PR-03 endpoint lifecycle semantics or PR-04 chapter/toc API semantics included.
  - ambiguity cleanup: deterministic rules specified for chapter filtering, TOC identity/order, archive failure classification, title normalization, and canonical asset retrieval path.
  - implementation readiness: deliverables/tests are executable by a junior implementer with no hidden dependencies.

## unresolved items
- none.

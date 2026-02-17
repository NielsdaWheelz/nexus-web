# s4 pr-08 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr08.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [x] scope auth uses canonical visibility helpers, not owner-only read helper.
- [x] annotation search visibility follows s4 highlight visibility, not owner-only filter.
- [x] message search for `scope=library:*` is enabled and constrained to conversations shared to target library.
- [x] unauthorized scope masking preserves existing typed 404 behavior:
  - [x] `media:* -> E_NOT_FOUND`
  - [x] `library:* -> E_NOT_FOUND`
  - [x] `conversation:* -> E_CONVERSATION_NOT_FOUND`
- [x] response shape remains `{ results, page }`.
- [x] tests updated in `python/tests/test_search.py` for shared conversation scope, shared annotation visibility, and library-scope message constraints.

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | pr-08 acceptance extraction | `docs/v1/s4/s4_roadmap.md` | 314-337 | pr-08 goal, dependencies, acceptance, non-goals extracted verbatim as drafting source. | seeded traceability matrix rows and cluster order. |
| e-002 | l2 search contract | `docs/v1/s4/s4_spec.md` | 792-816 | section 6.8 requires canonical conversation scope auth, shared annotation visibility, library-scope message search constraints, typed masking, and response-shape preservation. | defines normative behavior constraints for all pr-08 deliverables. |
| e-003 | current search scope auth gap | `python/nexus/services/search.py` | 149-174 | `authorize_scope(...)` still uses `get_conversation_for_owner_write_or_404(...)` for `scope=conversation:*`. | forces replacement with canonical read visibility helper in pr-08. |
| e-004 | current annotation visibility gap | `python/nexus/services/search.py` | 477-531 | `_search_annotations(...)` still enforces owner-only clause `h.user_id = :viewer_id`. | forces update to s4 highlight visibility semantics. |
| e-005 | current library-scope message gap | `python/nexus/services/search.py` | 544-568 | `_search_messages(...)` returns empty result for `scope_type == "library"`. | forces explicit library-scope message query support. |
| e-006 | canonical helper baseline | `python/nexus/auth/permissions.py` | 154-248 | canonical bool helpers exist for `can_read_conversation(...)` and highlight intersection logic; query-level helper surface for conversation visibility cte is not explicit in permissions module. | raises forced decision on helper reuse vs helper extraction for search sql paths. |
| e-007 | route-level response shape baseline | `python/nexus/api/routes/search.py` | 85-98 | route returns top-level `results` + `page` object today. | response shape must remain unchanged in pr-08. |
| e-008 | search test baseline still s3-oriented | `python/tests/test_search.py` | 5-10, 220-252 | file comments and assertions still encode owner-only annotation assumptions and lack library-scope message constraints. | requires explicit replacement/addition of s4-aligned tests. |
| e-009 | canonical conversation sql baseline from pr-06 | `python/nexus/services/conversations.py` | 256-281 | pr-06 conversation list visibility cte includes owner/public/library-share with active viewer+owner dual membership. | search conversation visibility cte must match this baseline semantics. |
| e-010 | search conversation cte drift | `python/nexus/services/search.py` | 195-225 | current search cte library path checks viewer membership only; owner membership gate is missing. | requires cte parity update for canonical conversation visibility. |
| e-011 | l2 library-scope message constraints | `docs/v1/s4/s4_spec.md` | 809-813 | message row must be shared to target library and still satisfy section 5.3 visibility; owner/public-but-unshared rows must be excluded. | defines exact include/exclude predicate for library-scope message search tests. |
| e-012 | l2 typed masking and response shape constraints | `docs/v1/s4/s4_spec.md` | 796-803, 813-816 | `/search` shape stays `{results,page}` and unauthorized scopes preserve typed 404 codes. | locks non-regression assertions for route/service outputs. |
| e-013 | media provenance mismatch risk in search paths | `python/nexus/services/search.py`; `docs/v1/s4/s4_spec.md` | search 181-192; spec 794-795 | search visible-media cte uses membership-only path while spec requires section-5 visibility predicates. | adds hardening requirement to upgrade cte provenance semantics and add stale-default-row regression test. |
| e-014 | existing scope tests already encode typed masking baseline | `python/tests/test_search.py` | 348-358, 396-406, 440-450 | tests assert `E_NOT_FOUND` for media/library and `E_CONVERSATION_NOT_FOUND` for conversation scope. | preserve and extend these tests while changing scope auth internals. |

## notes
- phase 1 complete: skeleton docs created (`s4_pr08.md`, `s4_pr08_decisions.md`, `s4_pr08_worklog.md`).
- phase 2 complete: acceptance clusters drafted with explicit decisions for scope auth, annotation visibility, library-scope message constraints, masking, and shape invariants.
- phase 2 hardening added: media-provenance alignment requirement captured to prevent hidden auth drift in search media/fragment/annotation paths.
- phase 3 completeness pass complete: every l3 pr-08 acceptance bullet is mapped in traceability with explicit tests.
- ambiguity cleanup complete: filled missing acceptance-test definition for conversation-scope not-visible masking case.
- decision lock pass complete: d-001 through d-007 set to `locked` in `s4_pr08_decisions.md`.
- final critical pass findings patched:
  - removed decision/constraint tension on optional cross-module helper extraction by locking pr-08 as behavior-focused only.
  - removed redundant masking aggregate test requirement and reused existing typed scope-masking tests.
  - made library-scope message inclusion explicitly require active `sharing='library'` state in addition to target share row.

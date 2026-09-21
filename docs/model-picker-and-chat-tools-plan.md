# chat controls: selection and tools

status: implementation verified; deployment cutover pending
origin: 2026-09-21 owner decisions; interaction, architecture, and verification reviews

## outcome and scope

replace the catalog inspector with inline **provider → model → effort** controls.
make the existing chat tools available on every new chat run. remove the
per-reply write checkbox and all its explanatory copy. apply this to send,
rerun, and regenerate.

reuse catalog, admission, workers, tools, receipts, and undo. background policy
and history remain factual. non-goals: database changes, new providers/settings,
ranking, synthetic presets, global preferences, search, permission frameworks,
or permanent test infrastructure.

## feature design and content contracts

the picker designer owns this content schema: exact identities, stable names,
no explanation.

| field | content and interaction |
| --- | --- |
| provider | native labelled select; distinguish openai api, openai codex, and direct/intermediary routes. derive options from the catalog. |
| model | native labelled select limited to that route; preserve source names. a sole model is a labelled value without a chevron. |
| effort | source-supported labels in source order; native radios styled as segments. selected value and keyboard focus are visible. a sole effort is a labelled value. |
| incomplete choice | `choose model` in an unselected model dropdown; `EffortRequired` shows enabled radios with none checked. dependent controls stay disabled until their parent exists. |

labels: `provider`, `model`, `effort`. no search, headings, descriptions,
metadata, badges, statuses, warnings, or confirm footer. preserve source
model/effort spelling; route identity never comes from its display label.

wrap/stack controls within their container; effort may wrap with full labels.
reuse focus/color/44px tokens and `SelectField`/`Select`; style native radios
locally. no measurement javascript, mobile widget variant, draggable model
slider, or reuse of `Tabs` with its incorrect semantics.

the tools designer owns action/result content: truthful results, failures, and
existing undo. delete checkbox, tool list, announcements, reset messages, and
“writes are off” copy. no replacement explanation or permission prompt. loading
failures, unavailable selections, and execution errors use the caller's existing
error surface outside the picker; no routine banners.

## selection capability and state

the backend catalog is the capability authority. offer only `Selectable`
efforts and their parents. retain a chosen unavailable identity visibly by
label or exact key, but do not offer it as an alternative. never substitute it.
an unavailable value keeps a replacement selector even with one alternative;
static singleton presentation applies only to the valid selected value.

one controlled draft replaces active/pending/confirmed choices. define in
`lib/conversations/generationSelection.ts`:

```text
SelectionDraft =
  { kind: "Uninitialized" }
  | { kind: "ModelRequired", route: GenerationRoute }
  | { kind: "EffortRequired", route: GenerationRoute, modelKey: string }
  | { kind: "Selected", selection: GenerationSelectionSpec }

ChatDraftRecord = { text: string, selection: SelectionDraft,
                    operation: ChatSendOperation }
```

reuse `GenerationRoute` and `GenerationSelectionSpec`: codex
`{route, model, reasoning}` or api `{route, model_ref, reasoning}`. partial state
never crosses the api. store identifiers; derive rows and eligibility.

the existing composer draft store persists this type; candidate editing uses it
locally. picker props: `catalog`, `value`, `onChange`, `disabled`; no loading or
submission. the new module owns transitions/decoding and reuses `selectionFor`
and `findGenerationCandidate`.

| event | required transition |
| --- | --- |
| initialize | wait for draft restoration, causal-history resolution, and catalog loading. restore any saved partial/complete choice. only `Uninitialized` takes causal assistant selection, otherwise the developer seed, once. candidate editing starts from its source run. |
| change provider | clear model/effort. a sole eligible model immediately follows the change-model transition; otherwise enter `ModelRequired`. |
| change model | clear effort. choose a selectable source default, otherwise a sole selectable effort; otherwise enter `EffortRequired`. never invent a first/middle default. |
| change effort | construct `Selected` using the exact catalog selection. |
| refresh | update alternatives/eligibility only; preserve identifiers and focus if its control survives, otherwise focus the nearest surviving field without selecting it. |
| send/run | require `Selected` and current catalog eligibility; freeze the exact tuple and revision into the existing command. |

edits apply immediately without execution. delete render-time
`selection ?? inherited ?? seed`. partial drafts survive reload and block send;
unavailable complete choices also block execution. no usable catalog means no
executable command.

rerun/regenerate keep existing eligibility and explicit, operation-named buttons.
opening/choosing/dismissing launches nothing. closing discards candidate edits;
composer edits persist. changes retain control focus; pointer and keyboard agree.

reuse `useGenerationCatalog` and its cache/retry. replace picker-open polling
with refresh on entering the control group and after a catalog-related refusal;
retain initial load and last valid snapshot. no perpetual inline-picker timer.

## chat policy, api, and composition

replace `ChatPerRunTools` with existing `ExactModelTools`:

```text
plan_id: ChatReadAdditiveWrite
authority_revision: existing plan revision
effect_mode: AdditiveWrites
scope_derivation: ChatAdmittedContext
```

the browser submits an exact choice. admission freezes policy and scope;
both adapters use the existing canonical runtime, owner mutations, receipts,
and undo. the browser never supplies tool authority.

final strict request fields; existing endpoint paths and envelopes remain:

```text
POST /chat-runs:
  destination, content, catalog_definition_revision, selection, reader_selection
POST /messages/{assistant_message_id}/rerun or /regenerate:
  catalog_definition_revision, selection
```

remove `tool_authority` from inputs, builders, decoders, forwarding, request
fingerprints, and reset plumbing. reject the retired field as an extra; no
ignored parameter, default, alternate endpoint, or compatibility decoder.

generation admission derives and freezes authority from policy. remove the
per-run branch from context assembly, keep existing additive-tool instructions
and user-directed action semantics, and bump the prompt revision. remove
`ChatPerRunTools`, its validators, and the misleading `ChatToolAuthority` alias;
reuse the existing general effect type. delete the unused `ChatRead` executable
plan after the cutover drain. keep the additive plan's identity/revision.

the existing eleven chat tools and their limits remain: web search, five nexus
reads, five additive writes, including the eight-live-write limit. ownership,
scope, capability validation, receipts, and undo remain enforced. preserve
frozen `tool_effect_mode` and historical `RunSelectionOut.tool_authority` as
facts, including old read-only runs. they are not client preferences.

every new send/rerun/regeneration uses the fixed plan. same-command retry reuses
the original key, request, admission, run, and effects. a new rerun is a new run
and can perform additions again.

## non-overlapping implementation ownership

paths below are relative to `apps/web/src/` or `python/nexus/` as indicated.
review each step against this contract before handing it to the next owner.

| owner | exclusive files and responsibility |
| --- | --- |
| a: tools designer/backend | python `services/{generation_policy,generation_service,chat_runs,context_assembler,chat_failure}.py`, `services/tool_runtime/{plans,plan_revisions}.py`, `schemas/conversation.py`, `api/routes/chat_runs.py`. owns policy, strict inputs, prompt, admission, dead plan/revision removal. |
| b: picker designer/frontend | web `components/chat/GenerationSelectionPicker.tsx` and css; new `lib/conversations/generationSelection.ts`; dead picker-only helpers in `lib/conversations/generationCatalog.ts`. owns content, transitions, local schema/decoder, native controls, keyboard/layout. no caller edits. |
| c: integration | web `ChatComposer`, `CandidateGenerationPicker`, `Conversation`, `useConversation`, `useChatDraft`, `useGenerationCatalog`, `ChatFailureCard`, `AssistantDetails` in `components/chat/`, affected local css; `lib/conversations/{chatDraftStore,chatRunBody,chatAdmission,types}.ts`, `lib/api/sse/requests.ts`. owns draft persistence, caller execution, history readiness, schema consumption, and tool-choice/reset removal. starts after a/b contracts settle. |
| d: verification/review | temporary end-to-end/live tests, cutover operation, and docs `modules/chat.md`, `modules/llms.md`, this plan, relevant tickets/register. owns adversarial acceptance; no duplicate application implementation. |

a/b work independently; c joins them. b/d review picker content; a/d review
tool content. delete orphaned picker search/listbox/dialog/detail code, styles,
imports, and props. retain provenance consumers. no generic widget framework.

## hard cutover and explicit trade-offs

- provider-first adds a step across vendors; it exposes the actual route.
  visible/wrapping effort costs space; native controls cost bespoke styling.
  hidden unavailable alternatives sacrifice discovery. source defaults reset
  effort on model changes. persisted partial choices add one small draft union
  but prevent reload from reviving a different target. no global preference memory.
- always-on tools accept unintended additions and repeated additions on a new
  run. existing undo and live repair are the recovery mechanism.
- strict request/draft changes require coordinated release and quiescence.
  unconditional immediate rollback with unsettled commands is incompatible with
  removing compatibility paths; rollback requires the same drain.

before switching, quiesce all app/browser/webview contexts. use the old release
to settle every submitting, reconciliation-required, and acknowledged draft
operation; finish admitted runnable chat generations. an unresolved command
blocks cutover. never mutate its bytes, discard it, or reissue it under a new key.

export settled editable `nx_chat_draft.v3:` records from each context. a one-time
operator conversion writes v4 records with the same key suffix/text, maps an
exact selection to `Selected` and null to `Uninitialized`, removes
`toolAuthority`, and requires `operation.kind === "Absent"`. read back before
removing v3. deploy coordinated clients/server and verify restoration. preserve
the export until verified. ship only the v4 decoder; remove conversion tooling
after use. before rollback, explicitly complete partial choices: v3 cannot
represent them. convert current drafts once (`Selected` → exact selection,
`Uninitialized` → null, `toolAuthority` → `ReadOnly`, the old release's default);
never restore an older export over newer draft text.

no database rewrite or history reset. revise module docs to this final contract;
remove their obsolete picker/permission requirements and missing cutover links.

## temporary red/green/refactor acceptance

the owner's explicit request authorizes temporary end-to-end/live tests for
this change, superseding the static-only restriction in
`local-rules/testing-standards.md` for that work only. do not change permanent
`./scripts/test`, ci, dependency locks, or add test-only production seams.

1. **red:** build a disposable browser/api harness outside shipped code. observe
   failures for the new controls and default write policy on the old release.
   existing replay/undo checks may already pass; do not manufacture failures.
2. **green:** implement a/b/c; use actual authenticated browser, bff, api,
   database, and interactive worker. browser catalog fixtures cover rare option
   shapes. a disposable external-transport fixture at existing constructor seams
   may capture model/effort and force a tool call; never mock admission, storage,
   worker logic, or tool execution. the owner explicitly skipped live codex/api
   provider runs on 2026-09-21. fixture success is not live-provider proof.
3. **refactor:** adversarially review each feature's content, state, ownership,
   schemas, dead paths, and replay. rerun only affected assertions, then run
   `./scripts/test`. no known acceptance failure may be waived as simplification.
4. **delete:** remove temporary tests, fixtures, harness/dependencies, owned test
   data/processes, and conversion tooling. retain a terse nonsecret verification
   receipt here; run `./scripts/test` on the final tree.

required behavioral assertions:

- zero/one/many models, missing/default/sole efforts, provider narrowing, exact
  api/codex identity, and unsupported effort filtering; request, admitted run,
  and actual adapter dispatch agree with the visible complete tuple.
- partial choices survive reload and block all send paths; refresh preserves an
  unavailable current target without substitution. no-choice and load failures
  are intelligible outside the picker.
- keyboard and pointer match; focus/selected value stay visible at narrow width
  and increased zoom. no search, metadata, status chrome, or tool checkbox.
- choosing/dismissing rerun/regenerate makes zero run-creation requests; its
  explicit action admits one run. all new run forms freeze the write-capable policy.
- retired authority inputs are rejected; historical read-only runs remain
  readable; runtime starts after dead plan/revision removal. settled draft
  conversion preserves text/identity/selection and refuses non-absent operations.
- one real additive write is durable and appears in existing results; undo
  reverses it. drop an accepted send response, reload, and retry: same key/body,
  same run, no duplicate write. inspect admission and tool receipts, not just ui.

verification receipt, 2026-09-21: the old picker and authority policy failed
disposable red probes. the locked provider runtime was restored. chromium
passed 13 picker interaction/accessibility checks, composer and candidate
draft/action checks, real history-failure/retry inheritance, and recovery from
a cached catalog with no selectable pair. strict api probes and authenticated
api → database → claimed worker fixtures verified exact adapter selection,
fixed additive policy on send/rerun/regenerate, durable note creation and undo,
and one effect on same-key replay. a browser lost-response/reload/retry passed
through the real next bff with an identical request, one job, and one tool call.
settled v3 → v4 conversion passed the v4 decoder and refused unsettled records.
`./scripts/test` passed. the owner skipped actual provider calls; the full next
conversation page crashed chromium during compilation under host memory
pressure, so the bff proof mounted the real composer in a same-origin fixture.
operational quiescence, context conversion, and deployment have not run in this
branch. disposable tests and isolated services/data were removed.

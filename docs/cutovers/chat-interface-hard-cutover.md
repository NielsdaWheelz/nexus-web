# Chat Interface Hard Cutover

**Status:** IMPLEMENTED · **Scope:** chat presentation and interaction only ·
**Doctrine:** hard cut; one owner per capability; no compatibility path

## 1. Decision

Make chat read like a conversation, not an instrumentation panel:

- content is primary;
- identity comes from turn layout, not repeated `You` / `Assistant` labels;
- routine state is quiet and exceptional state is visible;
- details are available on demand;
- every visible chat row activates reliably;
- every surface reflows inside its pane.

This is the 80/20 cut. It changes no chat-run, persistence, streaming, branching,
reader-selection, or pane-routing semantics.

## 2. Locked decisions

1. Assistant prose uses the normal sans text register in chat. `MachineText`
   remains the owner for dossiers, Synapse, Dawn, and other machine artifacts.
2. Standard provider retention moves behind a compact `Privacy` disclosure.
   Exceptional retention remains visible beside the selected profile.
3. Conversation-row activation is fixed in shared `ResourceRow`; no
   conversation-only click handler or nested interactive row is added.
4. Inline citations remain. The repeated source list and run diagnostics become
   closed disclosures.
5. The existing quote snapshot, send, cancel, rerun, reconnect, fork, walk, and
   Undo capabilities remain.
6. No blocking product question remains.

## 3. Goals

- Make long assistant answers comfortable to read.
- Remove permanent, self-evident, or duplicate chrome.
- Make chat-list activation work across the row's inert area.
- Prevent quote or message content from widening the pane.
- Keep actionable writes, failures, warnings, and active work visible.
- Replace stringly send/privacy state with exhaustive typed contracts.
- Delete superseded components, CSS, tests, and documentation requirements.

## 4. Non-goals

- No database migration or new endpoint.
- No change to `ChatRun`, SSE, tailing, cancellation, idempotency, or retries.
- No send queue or concurrent user turn while an assistant run is active.
- No avatars, reactions, presence, read receipts, unread counts, or new
  message-copy action.
- No last-message preview query, conversation search redesign, or virtualization.
- No new settings page, typography preference, mobile shell, or chat framework.
- No global deletion of `MachineText`.
- No redesign of Oracle, dossier, Synapse, Dawn, or reader surfaces.
- No selected-chat state spanning independent panes.

## 5. Target behavior

### 5.1 Transcript

- User and assistant turns share a `66ch` maximum prose measure, `16px` minimum
  prose size, `1.5-1.6` line height, normal sans body, and normal ink.
- Narrow panes use the available width; the transcript never creates pane-level
  horizontal scroll.
- User turns retain the quiet accent rail. Assistant answers have no machine
  rail, mono body, origin signature, or permanent role heading.
- `You` and `Assistant` are not visible. The turn root retains `data-role`, and
  each turn has a screen-reader label (`Your message`, `Assistant response`).
- One quiet timestamp follows either role. It appears on hover/focus for precise
  pointers and remains visible where hover is unavailable.
- Assistant content order is:

```text
active tool status, when running
answer
publication warning, when present
write trail + Undo, when present
Sources (N), closed
Details [warning count], closed
failure/reconnect, when present
Fork / Walk actions
fork strip, only when forks exist
```

- Inline citation markers remain active in the answer.
- `Sources (N)` contains the current numbered source links and is closed by
  default.
- `Details` contains model/profile, reasoning, usage, cost, tool/retrieval
  counts, context references, and integrity notices. Only a warning count may
  decorate the closed summary.
- The existing colophon is deleted; it duplicates `Details`.
- Fork and Walk move below the answer. On hover-capable devices they appear on
  turn hover/focus; on touch they remain visible.
- Completed read-only tool detail is not duplicated outside `Details`. Active
  tool status remains visible only while work is active.

### 5.2 Composer

- The draft stays editable while the assistant runs. `Stop` remains the primary
  run control.
- Routine blocked-send state never occupies the red error slot.
- Real send errors, ambiguous-send reconciliation, stale quotes, and failures
  remain visible and actionable.
- A blocked Enter/send attempt does not clear the draft or move focus.
- The blocked reason is available to assistive technology through one polite
  live region; surrounding visible state supplies the sighted explanation.
- Standard profile privacy copy appears only when the user opens `Privacy`.
- `ExceptionalRetention` copy is always visible while that profile is selected.
- Profile and reasoning selectors remain native `Select` controls.

### 5.3 Quote

- `QuotedPassageCard` fits its containing pane at every width.
- Its semantic `<figure>` has zero outer margin, border-box sizing,
  `min-inline-size: 0`, and `max-inline-size: 100%`.
- Source names, quotes, URLs, and identifiers wrap without widening the pane.
- The preview is three lines in both pending and sent modes; one disclosure
  reveals the complete immutable quote in place.
- Source activation and pending Remove/Retry behavior remain unchanged.

### 5.4 Conversation list

- Title, supporting metadata, activity, and blank row chrome activate the
  existing primary link/button.
- Nested links, menus, and controls activate only themselves.
- Link semantics remain real anchor semantics, including modified click and
  keyboard activation. The `<li>` is never a second button.
- Focus-visible styling identifies the whole active row.
- Each row shows only data already returned by the list API:
  `<relative updated time> · <message count>`.
- `next_cursor` is the sole pagination continuation signal; no synthetic
  `has_more` field enters pane return state.
- Formatting reuses `formatRelativeTime`, `formatDisplayNumber`, and the injected
  render-environment instant; render code never reads the wall clock.
- Empty titles use the existing `Untitled chat` rule.
- Selecting a row navigates through the existing pane route pipeline and opens
  that conversation.

## 6. Final architecture

```text
ConversationSummary
  -> conversation presentation helpers
  -> CollectionRow
  -> ResourceRow primary activation
  -> PaneRouteBoundary
  -> Conversation

conversation tree/run state
  -> useConversation
  -> ChatSendCapability
  -> ChatComposer

LLM profile registry
  -> LlmProfileOut
  -> GET /llm-profiles
  -> useChatProfiles
  -> ChatComposer
  -> resolveChatProfileSelection
  -> ChatProfilePicker

ConversationMessage
  -> MessageRow
     -> UserMessage
     -> AssistantMessage
        -> AssistantAnswer
        -> ChatPublicationNotice
        -> AssistantWriteTrail
        -> MessageSourcesDisclosure
        -> AssistantDetails
```

| Capability | Sole owner | Consumers |
| --- | --- | --- |
| Turn role and timestamp | `MessageRow` | user, assistant, system renderers |
| Assistant hierarchy | `AssistantMessage` | conversation transcript |
| Answer Markdown/citations | `AssistantAnswer` | `AssistantMessage` |
| Consequential writes + Undo | `AssistantWriteTrail` | `AssistantMessage` |
| Run/tool/source diagnostics | `AssistantDetails` | `AssistantMessage` |
| Send availability derivation | `useConversation` | `ChatComposer` |
| Causal inherited profile selection | `useConversation` | `ChatComposer` |
| Ready-catalog selection precedence | `resolveChatProfileSelection` | `ChatComposer` |
| Profile privacy classification | `llm_profiles.py` registry | profile API/UI |
| Quote geometry and disclosure | `QuotedPassageCard` | composer, user turn |
| Collection row hit target | `ResourceRow` | every collection row |
| Conversation title/count/time copy | `lib/conversations/presentation.ts` | list, destination picker |

Use native `<details>/<summary>` for the three small disclosure surfaces. Do not
add a generic disclosure framework; their visual contracts differ.

## 7. Capability contracts

### 7.1 Send capability

Replace `sendDisabledReason: string | null` and
`ChatComposer.disabledReason?: string` with:

```ts
export type ChatSendCapability =
  | { readonly kind: "Available" }
  | { readonly kind: "HistoryLoading" }
  | { readonly kind: "AssistantRunning" }
  | { readonly kind: "ReplyTargetUnavailable" };
```

`useConversation` derives exactly one variant. `ChatComposer` exhaustively maps
it to send gating and accessible copy. Local `sending`, `reconciling`, empty
draft, missing profile, and pending quote hydration remain composer-owned
conditions; they are not added to this caller capability.

Profile/reasoning continuation is governed by
`chat-continuation-selection-hard-cutover.md`: `ChatComposer` owns the cached
catalog and resolves explicit draft choice, causal assistant-run selection, and
the exact product default in that order. `ChatProfilePicker` is a pure
controlled renderer and owns no fetching, defaulting, validation, or mount-time
mutation.

### 7.2 Profile privacy API

Hard-replace `privacy_notice: string` with this nested union on every profile:

```json
{
  "privacy": {
    "kind": "Standard",
    "notice": "Standard provider retention. ..."
  }
}
```

```json
{
  "privacy": {
    "kind": "ExceptionalRetention",
    "notice": "Anthropic retains ..."
  }
}
```

Rules:

- Wire discriminator values are exactly `Standard` and
  `ExceptionalRetention`.
- The registry owns classification and copy.
- `LlmProfileOut` projects the union; the route and BFF remain thin.
- The browser exhaustively switches on `privacy.kind`.
- Delete `privacy_notice` everywhere. No optional field, decoder fallback,
  dual payload, version, or compatibility alias remains.
- No acknowledgement state is persisted.

## 8. Layout and interaction rules

- One transcript scroll owner remains `ChatSurface`.
- Message content uses logical sizing (`inline-size`) and `min-width: 0` through
  every grid/flex boundary.
- Ordinary prose wraps. Code blocks and tables may scroll only inside their own
  bounded container.
- A `ResourceRow` interactive primary expands over inert row chrome without
  adding an `onClick` to the root or nesting controls.
- Interactive descendants remain above the expanded primary hit target.
- Focus, hover, touch, and reduced-motion behavior are explicit; hover never
  hides the only available action on touch.
- Color is not the only signal for failure, warning, selected, or focus state.
- Disclosure summaries are native buttons in the accessibility tree, retain
  visible focus, and expose expanded state without custom JavaScript state.

## 9. Hard cut and deletions

- Remove chat's `MachineText` wrapper and assistant signature/time formatting.
- Rename `AssistantEvidenceDisclosure` to `AssistantAnswer`.
- Rename `MessageFootnotes` to `MessageSourcesDisclosure`; delete the old files.
- Split `AssistantWriteTrail` from `AssistantTrustInspector`.
- Rename the retained inspector to `AssistantDetails`; delete the old files.
- Delete `Colophon.tsx`, its CSS, both tests, imports, and helpers.
- Delete visible role-label markup and orphaned kicker/signature styles.
- Delete `privacy_notice`, `sendDisabledReason`, and
  `ChatComposer.disabledReason`, including their tests, comments, and fixtures.
- Remove the machine-hand guard that requires chat Markdown to be inside
  `MachineText`; retain token ownership and non-chat consumer guards.
- Update superseded requirements in:
  `machine-hand-hard-cutover.md`, `correspondence-hard-cutover.md`,
  `assistant-message-trust-trail-hard-cutover.md`,
  `reader-highlight-quote-chat-hard-cutover.md`, and `docs/modules/chat.md`.

## 10. File plan

| Area | Files |
| --- | --- |
| Transcript | `components/chat/{MessageRow,UserMessage,AssistantMessage,AssistantAnswer,AssistantWriteTrail,MessageSourcesDisclosure,AssistantDetails}.*`; `components/ui/MarkdownMessage.module.css` |
| Delete | `components/chat/{AssistantEvidenceDisclosure,MessageFootnotes,AssistantTrustInspector,Colophon}.*` after replacements land in the same change |
| Composer | `components/chat/{ChatComposer,ChatProfilePicker,useConversation}.*` |
| Quote | `components/chat/QuotedPassageCard.*` |
| List | `components/ui/ResourceRow.*`; `lib/conversations/presentation.ts` (new); `lib/collections/presenters/conversation.ts`; `components/chat/ConversationDestinationOverlay.tsx`; `app/(authenticated)/conversations/ConversationsPaneBody.tsx` |
| API/schema | `python/nexus/services/llm_profiles.py`; `python/nexus/schemas/llm.py`; `python/tests/{test_llm_profiles,test_llm_schemas}.py`; `lib/conversations/types.ts` |
| Guards/docs | `lib/ui/machineHandCutover.guards.test.ts`; the five documents in §9 |
| Journey | `e2e/tests/conversations.spec.ts` |

Do not touch conversation storage, chat-run routes, SSE decoders, pane route
models, reader-selection schemas, or BFF behavior.

## 11. Implementation order

1. **Contracts:** add red tests; hard-replace profile privacy and send
   capability types.
2. **Transcript:** cut MachineText/labels/colophon; establish hierarchy and
   disclosures; delete old files in the same slice.
3. **Reflow:** fix quote and hostile-content containment at `320px`.
4. **Activation:** widen shared `ResourceRow` primary hit area; reuse existing
   conversation count/time formatting; prove the real route journey.
5. **Docs/guards:** remove contradicted requirements and stale names.

No slice may leave old and new contracts live together.

## 12. Acceptance criteria

- **AC-1:** A multi-paragraph assistant answer renders in normal sans/ink at
  readable measure and line height, with no visible role label or machine
  signature.
- **AC-2:** User and assistant turns retain programmatic role identity and
  accessible labels.
- **AC-3:** Sources and Details are closed by default; inline citations, source
  activation, warnings, and write Undo still work.
- **AC-4:** No colophon or duplicate completed-tool summary renders.
- **AC-5:** While an assistant run is active, the draft remains editable, Stop
  remains available, and no red “wait” banner renders.
- **AC-6:** Real composer errors remain visible and distinct from capability
  state.
- **AC-7:** Standard privacy copy is user-invoked; exceptional retention copy is
  visible whenever selected.
- **AC-8:** `privacy_notice`, `sendDisabledReason`, and
  `ChatComposer.disabledReason` have zero production or test references.
- **AC-9:** A pending or sent quote with a long source name and unbroken content
  causes no pane-level overflow at `320 CSS px`; full quote disclosure works.
- **AC-10:** Clicking title, metadata, or inert whitespace in a conversation row
  opens the conversation. Its action menu never opens the conversation.
- **AC-11:** Enter and modified-click behavior use the existing real activation
  element and pane-routing path.
- **AC-12:** Long prose, links, code, and tables cannot widen the transcript;
  only bounded code/table containers may scroll horizontally.
- **AC-13:** Existing send, Stop, rerun, reconnect, fork, walk, quote-source,
  citation, and Undo behavior passes unchanged.
- **AC-14:** Old components, styles, guards, fixtures, and contradictory docs
  are deleted, not deprecated.

## 13. Verification

Write behavior tests first, then run only the focused owners:

- backend profile registry/schema tests;
- `ChatComposer`, `ChatProfilePicker`, `useConversation`;
- `MessageRow`, `AssistantMessage`, quote, and machine-hand guard tests;
- `ResourceRow` and `ConversationsPaneBody`;
- horizontal-overflow helper at `320px`, including long URL, identifier, code,
  and table fixtures;
- one real `conversations.spec.ts` journey from chat list row to loaded
  transcript, plus nested-menu non-navigation;
- focused frontend typecheck/lint and `git diff --check`.

Tests assert rendered behavior, routing outcomes, and API shape. They do not
assert component nesting, CSS implementation technique, or internal helper
calls.

## 14. Final-state laws

1. The answer is the product; metadata is apparatus.
2. Identity is encoded once.
3. Routine state consumes no permanent vertical space.
4. Exceptional state is visible at the point of decision.
5. One capability has one typed owner.
6. A visible row has one reliable primary activation.
7. A pane owns its width; descendants cannot enlarge it.
8. Old contracts and their proof artifacts do not survive the cutover.

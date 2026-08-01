# Chat Composer Instrument Hard Cutover

**Status:** IMPLEMENTED · DEVICE ACCEPTANCE PENDING · **Date:** 2026-07-31 ·
**Scope:** composer presentation and input behavior only · **Doctrine:** hard
cut; one owner; no compatibility path

## 1. Decision

Make the composer feel like Nexus's inkwell: a quiet, complete writing
instrument whose craft appears through proportion, material, response, and
clarity—not extra controls or effects.

This is the 80/20 cut. Keep exactly the existing writing, Model, Effort, Send,
Stop, and Retry capabilities. Replace their presentation and correct keyboard,
IME, focus, touch-target, contrast, and long-draft behavior. No blocking product
question remains.

Governing contracts: [repository rules](../rules/index.md),
[testing standards](../local-rules/testing-standards.md),
[chat module](../modules/chat.md),
[chat interface cutover](chat-interface-hard-cutover.md), and
[continuation selection cutover](chat-continuation-selection-hard-cutover.md).
This document narrows their composer presentation; it does not replace their
domain ownership. Repository rules win on conflict.

## 2. Goals

- Make writing the visual primary action on desktop and mobile.
- Give the composer one deliberate, theme-native surface and stable action rail.
- Preserve exact product-profile, effort, send, cancel, and retry semantics.
- Make every state legible without moving the primary action.
- Meet keyboard, IME, focus, contrast, touch, and narrow-viewport requirements.
- Delete the superseded composer presentation and its tests.

## 3. Scope and non-goals

In scope:

- `ChatComposer`, `ChatProfilePicker`, and their CSS;
- the shared `Textarea` auto-grow overflow defect;
- focused browser tests, the existing real-stack conversation journey, and chat
  module documentation.

Non-goals:

- no database, endpoint, request, response, SSE, or persistence change;
- no change to profile resolution, send availability, idempotency, branching,
  quote hydration, cancellation, reconciliation, or scroll ownership;
- no raw provider/model selector, Auto routing, remembered global preference,
  searchable/custom picker, sheet, recents, favorites, or provider logos;
- no attachment, voice, haptic, notification, command, or shortcut-discovery
  feature;
- no global `Button` or `Select` redesign, new theme, dependency, animation
  library, viewport reader, fixed positioning, blur, glass, or gradient;
- no quote-card or branch-header redesign beyond fitting the new shell.

## 4. Final anatomy

```text
ChatComposer                         existing behavior owner
└─ composer shell                    one complete visual surface
   ├─ exceptional status             error or reconciliation only
   ├─ branch header?                 unchanged
   ├─ pending quote?                 unchanged
   ├─ writing field                  2–6 rows, then internal scroll
   └─ action rail
      ├─ Model                       native product-profile select
      ├─ Effort?                     native reasoning select when variable
      ├─ quiet catalog/status copy?  only when required
      └─ action socket               Send | Sending | Stop | Stopping | Retry
```

The shell remains in normal flow inside `ChatSurface`. It never becomes fixed,
sticky, portalled, or a second scroll/keyboard owner.

## 5. Target behavior

### 5.1 Writing

- The textarea starts at two lines (approximately `48–52px`) and grows through
  six lines.
- Below the cap it has no scrollbar. Above the cap it keeps the capped height
  and exposes native internal vertical scroll. Shrinking the draft removes the
  scrollbar again.
- Mobile text is at least `16px`; browser focus never triggers input zoom.
- Placeholder and routine status copy use `--ink-muted`, not `--ink-faint`.
- A completed or known-failed send restores textarea focus with
  `preventScroll`. A blocked send preserves draft and focus.

### 5.2 Keyboard and IME

| Environment | Input | Result |
| --- | --- | --- |
| desktop | `Enter` | send once when available |
| desktop | `Shift+Enter` | newline |
| desktop | `Cmd/Ctrl+Enter` | send once when available |
| product mobile viewport | any `Enter` variant | newline |
| any | explicit action button | invoke its displayed action |
| any | composing `Enter` or key code `229` | IME owns the event; never send |

Use the existing `useIsMobileViewport` projection. Do not add `matchMedia`,
user-agent, touch, width, or Android-shell logic. Track composition start/end
and also inspect the native composing signal, following the existing Nexus input
precedent. Do not extract a generic keyboard helper: each input owns different
commands and propagation rules.

### 5.3 Model and Effort

- Keep native `Select` controls.
- The first control's accessible name is `Model`; visible option copy is the
  server-owned `LlmProfile.label`. Its value remains the product `profileId`.
- The second control's accessible name is `Effort`; its options and values remain
  the selected profile's server-owned reasoning options.
- Hide Effort when the selected profile exposes one option. Do not render an
  inert control.
- A Model change selects that profile's declared default Effort exactly as it
  does now.
- The browser never synthesizes labels, targets, ordering, defaults, or
  availability from provider/model metadata.

### 5.4 Stable action socket

Render one fixed-size icon-button socket at the action rail's trailing edge.
Derive its projection from existing state; add no stored state or exported state
machine.

| Existing state, in precedence order | Projection | Accessible name |
| --- | --- | --- |
| `reconciling` | neutral Retry icon | `Retry send` |
| active cancellable run + `cancelling` | neutral spinner | `Stopping response` |
| active cancellable run | neutral Stop square | `Stop response` |
| `sending` | accent spinner | `Sending message` |
| otherwise | accent Send arrow | `Send message` |

- The socket's dimensions do not change across states.
- Disabled Send remains in the same socket and explains nothing visually beyond
  its disabled treatment; the existing polite status owns blocked-state copy.
- Stop is interruption, not destruction: remove the danger-red treatment.
- Existing `Button` loading and reduced-motion behavior owns progress.
- Icons are decorative; the button name is stable, explicit, and state-accurate.

## 6. Visual and responsive contract

- Use one opaque `--surface-1` shell with a full `--edge` hairline,
  `--radius-2xl`, and restrained `--shadow-2` elevation in Study and Press.
- Use existing spacing, surface, edge, accent, ink, ring, shadow, radius,
  duration, and easing tokens. Add no composer-specific color system.
- `:focus-within` strengthens the complete shell edge/shadow. Interactive
  controls retain an unambiguous `:focus-visible` ring.
- Model and Effort read as quiet compact capsules. Send is the only accent-filled
  control when actionable.
- Desktop control height is compact (`36px`). Under `(any-pointer: coarse)`, all
  selects and the action socket are at least `44×44px`.
- The action rail uses one row when space permits. It may wrap status copy, but
  Model, Effort, and the action socket never overflow or become horizontally
  scrollable at `320px`.
- Use short color, border, and shadow transitions only. Never animate layout or
  textarea height. Existing reduced-motion tokens reduce all retained motion.

## 7. Architecture and ownership

```text
llm_profiles.py registry
  -> GET /api/llm-profiles
  -> useChatProfiles cache
  -> ChatComposer selection resolution
  -> ChatProfilePicker native controls

useConversation -> ChatSendCapability ┐
useChatDraft -> draft/send attempt     ├-> ChatComposer -> POST /api/chat-runs
pending turn context                   ┘

RenderEnvironmentProvider -> useIsMobileViewport -> composer key semantics
Textarea -> auto-grow height + overflow behavior
ChatSurface/useChatScroll/MobileViewportProvider -> unchanged viewport ownership
```

| Capability | Sole owner | Rule |
| --- | --- | --- |
| catalog/default | `llm_profiles.py` + `useChatProfiles` | unchanged |
| effective selection | `resolveChatProfileSelection` + `ChatComposer` | unchanged |
| explicit draft selection | `useChatDraft` | unchanged |
| send availability | `useConversation` / `ChatSendCapability` | unchanged |
| send/retry/cancel wiring | `ChatComposer` | unchanged behavior; new projection |
| mobile/desktop projection | `RenderEnvironmentProvider` | reuse only |
| textarea growth/overflow | shared `Textarea` | fix once for all auto-grow users |
| shell/rail/control styling | composer and picker CSS modules | no global primitive cut |
| transcript scroll/dock/keyboard obstruction | existing chat/mobile owners | do not touch |

## 8. Capability and API contract

No public component prop, TypeScript domain type, API shape, or schema changes.
Retain:

- `ChatComposerProps`;
- `ChatSendCapability`;
- `ChatProfileSelection` and `ResolvedChatProfileSelection`;
- `LlmProfile` / `LlmProfilesOut`;
- `GET /api/llm-profiles`;
- `POST /api/chat-runs` and its idempotency key;
- `buildChatRunBody` as the sole request assembler.

Presentation must exhaustively project existing conditions. Never duplicate
them into a `composerMode`, reducer, context, store, persisted field, URL field,
or backend value.

## 9. Reuse, consolidation, and deletion

Reuse:

- `Button`, `Select`, `Textarea`, Lucide icons, `useIsMobileViewport`;
- the Desktop Nexus composition guard pattern;
- `(any-pointer: coarse)` touch-target precedent;
- the existing global design and reduced-motion tokens.

Centralize only the shared auto-grow overflow correction in `Textarea`. Keep
composer geometry local; changing generic `Button` or `Select` would widen the
blast radius. Do not generalize keyboard handling in this cut.

Delete, do not retain beside the target:

- text `SEND` / `SENDING` and variable-width Retry geometry;
- danger Stop styling;
- top-border-only shell and focus treatment;
- permanent `overflow: hidden` after auto-grow reaches its cap;
- composer-local `640px` behavior superseded by the shared viewport projection
  and coarse-pointer target rule;
- obsolete selectors, classes, assertions, fixtures, comments, and docs for
  those paths.

No feature flag, legacy class, duplicate mobile component, fallback label, or
compatibility branch survives.

## 10. Files

| File | Required final change |
| --- | --- |
| `apps/web/src/components/chat/ChatComposer.tsx` | IME/mobile keys, focus, stable action projection |
| `apps/web/src/components/chat/ChatComposer.module.css` | shell, writing field, rail, socket, responsive rules |
| `apps/web/src/components/chat/ChatProfilePicker.tsx` | Model/Effort names; controlled native rendering |
| `apps/web/src/components/chat/ChatProfilePicker.module.css` | capsule geometry and containment |
| `apps/web/src/components/chat/useChatProfiles.ts` | remove obsolete `SEND` terminology from owner comments |
| `apps/web/src/components/ui/Textarea.tsx` | derived capped overflow behavior |
| `apps/web/src/components/ui/Textarea.module.css` | below-cap/above-cap overflow support |
| `apps/web/src/__tests__/components/ChatComposer.test.tsx` | observable composer contract |
| `apps/web/src/__tests__/components/ui/Textarea.test.tsx` | grow/cap/shrink overflow contract |
| `apps/web/src/__tests__/components/Conversation.test.tsx` | hard-cut composer names at the real consumer |
| `e2e/tests/conversations.spec.ts` | real composer send/select/narrow-viewport journey |
| `e2e/tests/{chat-composer,chat-streaming,quote-attach-references,reader-quote-to-chat}.spec.ts` | hard-cut composer locators only |
| `e2e/tests/real-media/context-chat-citations.spec.ts` | hard-cut composer locator only |
| `docs/modules/chat.md` | final behavior and ownership |
| this document | implementation status and final evidence |

Do not modify backend/profile registry, chat request types, `useChatDraft`,
`useConversation`, `ChatSurface`, `useChatScroll`, `MobileViewportProvider`,
`Button`, `Select`, or global theme files unless implementation proves a stated
contract impossible. Stop and amend this specification before widening scope.

## 11. Implementation record

1. Locked focused tests for keyboard/IME, action projection, selection, focus,
   narrow width, and textarea overflow; demonstrated sensitivity before fixes.
2. Fixed shared `Textarea` cap/scroll/shrink behavior.
3. Hard-replaced composer/picker markup and CSS in one reviewable cut.
4. Deleted superseded paths and updated chat documentation.
5. Recorded completed and open proof tiers in §14.

## 12. Acceptance criteria

- The only routine controls are Model, conditional Effort, and the one action
  socket; quote/branch/error surfaces appear only when their existing state
  requires them.
- Profile and effort selection produce the same product IDs and exact request
  body as before.
- Desktop Enter, Shift+Enter, and Cmd/Ctrl+Enter match §5.2; mobile Return adds a
  newline; IME composition never sends.
- One user action creates at most one POST. Blocked input creates none and loses
  neither draft nor focus.
- Send, Sending, Stop, Stopping, and Retry have correct accessible names,
  semantics, busy/disabled state, fixed geometry, and no danger Stop treatment.
- The textarea grows from two through six rows, scrolls above six, and removes
  overflow after shrinking.
- At `320px`, controls and arbitrary server labels remain contained with no page
  or pane horizontal overflow.
- Coarse-pointer targets are at least `44×44px`; mobile text is at least `16px`;
  keyboard focus is visible; placeholder/status copy meets `4.5:1` contrast in
  Study and Press.
- Mouse, touch, keyboard, screen-reader names, reduced motion, loading, catalog
  error, reconciliation, active run, branch, and pending-quote states remain
  operable.
- Focused browser tests and the real-stack conversation journey pass. Real iOS
  and Android keyboard/IME checks are required acceptance gates, not inferred
  from responsive desktop emulation.
- Searches find zero legacy labels/classes/branches named in §9. No application
  or test code supports both old and new presentations.

## 13. Completion rule

The cut is complete only when target behavior, deletion, documentation, and the
required proof all land together. A green focused test does not establish
real-stack, device, CI, deploy, or production acceptance.

## 14. Evidence snapshot

Passed on 2026-07-31:

- focused Chromium component proof: `ChatComposer` + `Textarea`, 36/36,
  including catalog loading/error, conditional Effort, reduced-motion loading,
  and the rendered focus-within ring;
- real consumer proof: `Conversation`, 19/19;
- targeted ESLint, CSS-token validation, diff hygiene, and zero legacy residue;
- rendered 320px human review in Study and Press;
- demonstrated red before fixes: the initial composer contract was 22/27,
  and textarea cap/overflow and border-box assertions failed;
- current production-stack non-default Model/Effort send → completion → reload:
  setup + Chromium journey, 2/2 in 2.2 minutes;
- current production-stack 320px containment/scroll/touch-target journey: setup
  + Mobile Chrome journey, 2/2 in 2.2 minutes.

Both final real-stack runs used the unchanged public `make test-e2e` target and
oracles with `CIRCLE_NODE_TOTAL=2 NODE_OPTIONS=--max-old-space-size=1536` to
bound Next 15.5.22 worker concurrency and heap on this memory-constrained host.

Open acceptance gates:

- real iOS and Android keyboard/IME checks are unrun: this Linux host has no
  Apple tooling, and its Android SDK has no attached device or configured AVD.

Unestablished higher proof tiers: CI, deploy, and production.

Close the remaining gates without substitutions:

1. On a real iPhone against that production build, execute the §5.2 mobile/IME
   matrix, send with the keyboard open, dismiss it without a residual gap,
   rotate while focused, and verify transcript scrolling and Back behavior.
2. On a real Android phone with System WebView M144+, run
   `make test-android`, then execute §5.2 with gesture and three-button navigation
   in portrait and landscape, including IME open/close, focused rotation,
   reduced motion, and a TalkBack-name smoke check. Instrumentation alone does
   not establish the physical composer/IME result.

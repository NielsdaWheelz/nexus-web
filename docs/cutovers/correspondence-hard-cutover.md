# The Correspondence — chat leaves the bubble; footnotes and a colophon — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. The bubble is deleted, not toggled.

## One-line

Re-typeset the conversation as an editorial exchange: kill user bubbles in favor of a full-measure inquiry line with a left-rail accent mark; flatten the composer to a writing desk; replace inline citation chips with scholarly superscript numerals and a `MessageFootnotes` block; and close every completed assistant turn with a `Colophon` — model · tokens · cost · sources, the printer's mark of honest provenance.

---

## 0. Prerequisites (hard, no fallback)

- **P-1. `machine-hand-hard-cutover.md` (SPEC) must land before S3.** S0, S1, and S2 of this spec are independent of machine-hand and may be built and merged in any order relative to machine-hand S0–S1. Only **S3** (wiring `Colophon` and `MessageFootnotes` into `AssistantMessage.tsx` inside the `MachineText` block) requires machine-hand S2 to be merged first. Machine-hand wraps all assistant prose in `MachineText` (block variant, origin `"Assistant"`), deletes the assistant hover `.timestamp` render site, removes the `timestampLabel` prop from `AssistantMessage.tsx`, moves `StreamingGutterCue` above the `MachineText` block, and sets `MarkdownMessage.module.css` `.markdown { color: inherit }`. `MessageFootnotes` and `Colophon` go **inside** the same block per machine-hand §4.4.

- **P-2. TrustRunOut already carries model and usage.** `AssistantTrustTrail.run.model_name` (string) and `AssistantTrustTrail.run.usage` (dict containing `input_tokens`, `output_tokens`) already reach the FE client via `message_trust_trails.py:490-511` — verified via `lib/conversations/types.ts:182-195`. `total_cost_usd_micros` is **not** currently in the client model; it requires one new JOIN in `build_assistant_trust_trails` (§5). `source_count` is derived client-side from `message.citations.length` — no backend change needed.

- **P-3. Bubble CSS lives in `MessageRow.module.css`.** The compact-bubble mode is `.userPromptCompact` (`MessageRow.module.css:41-49`): right-aligned, `max-width: min(72%, 46ch)`, `margin-inline-start: auto`, `border: 1px solid var(--edge-subtle)`, `border-radius: var(--radius-md)`, tinted background. The expanded mode is `.userPromptExpanded` (`MessageRow.module.css:51-58`): full-width, `border: 1px solid var(--edge-subtle)`, `border-inline-end: 3px solid var(--accent-muted)`, `border-radius: var(--radius-md)`. Both modes are deleted (§9).

- **P-4. Composer uses `--radius-2xl`.** `ChatComposer.module.css:16`: `.composerShell { border-radius: var(--radius-2xl) }`. Mobile override (`ChatComposer.module.css:93`, inside `@media (max-width: 640px)`): `border-radius: var(--radius-xl)`. Both are deleted (§9, D-2).

- **P-5. Citation chips live in `ReaderCitation.module.css`.** The chip styling occupies `ReaderCitation.module.css:1-22` (the `.citation` base rule): `display: inline-flex`, `border: 1px solid transparent`, `border-radius: var(--radius-sm)`, `padding: 0 3px`, `background: var(--surface-2)`, and six color-variant rules (`.yellow`, `.green`, `.blue`, `.pink`, `.purple`, `.neutral`) at `ReaderCitation.module.css:33-56`. These rules are replaced; the interactive behavior (`onActivate`, `HoverPreview`) is kept exactly.

- **P-6. `ChatRun` and `LLMCall` share a join path.** `LLMCall.owner_kind = 'chat_run'` and `LLMCall.owner_id = ChatRun.id` (`models.py:3960-3961`, `ck_llm_calls_owner_kind` at `models.py:4011-4013`). `ChatRun.assistant_message_id` (`models.py:4768`) links run to message. The bulk query path for cost is: `SELECT owner_id, SUM(total_cost_usd_micros) FROM llm_calls WHERE owner_kind='chat_run' AND owner_id = ANY(:run_ids) GROUP BY owner_id`.

---

## 1. Problem (grounded diagnosis)

### 1.1 The conversation surface still wears the generic-AI costume

Every list surface obeys the anti-card law ("borderless, type-forward, calm; a hairline rule gives rhythm"). The chat surface does not: user turns appear as right-aligned tinted cards (`MessageRow.module.css:41-49`), the composer is a glass blob (`ChatComposer.module.css:14-17`, `border-radius: var(--radius-2xl)`), and citation evidence is rendered as inline colored badge chips (`ReaderCitation.module.css:1-22`). `docs/scriptorium.md §VI` names this "the least-Nexus surface in the app." The three problems are mechanical and reversible:

1. Right-alignment and max-width shrink signal "chat app bubble" rather than "inquiry." There is no typographic precedent for this anywhere else in the product.
2. `--radius-2xl` is the one declaration in the product that exceeds `--radius-lg`, the dominant radius token. It belongs to no design doctrine; it crept in from the generic-AI template.
3. Citation chips (colored badges with `background: var(--surface-2)`, `border-radius: var(--radius-sm)`) look like UI controls, not references. The reader apparatus already renders source-authored citations as superscript markers linking to footnote lists; the chat surface uses a visually inconsistent scheme for the same scholarly function.

### 1.2 The cost ledger is tracked but never displayed

`llm_calls.total_cost_usd_micros` (`models.py:3987`) carries full USD-micros cost accounting per call, and `llm_calls.model_name` (`models.py:3965`) records the model used. Both are already captured, scoped to the run, and committed transactionally. Yet every completed assistant turn shows nothing about what it cost to generate. The trust trail already carries `run.model_name` and `run.usage` (tokens from the done event) to the client — `types.ts:182-194`. Only `total_cost_usd_micros` requires a new JOIN in the read path (`build_assistant_trust_trails`, `message_trust_trails.py:108`). The printer's colophon puts the ledger where the reader can see it — honesty as ornament.

---

## 2. Target behavior (user-facing)

**User sends a question.** The turn occupies full measure. A 2 px `var(--accent-muted)` left rail marks the column. A small-caps `YOU` kicker opens the row. The text is set in the reading register (`--font-sans`, `--ink`) at the prose measure. No tinted card, no right-alignment, no rounded container. On hover, the existing timestamp fades in as before (the shared `.timestamp` CSS is preserved).

**Assistant replies.** Set in the Machine Hand (`--font-machine`, `--ink-machine`) per the machine-hand cutover. In-prose citation numerals appear as clean superscripts (`<sup>[n]</sup>`), not colored chips. Below the prose a `MessageFootnotes` block opens with a hairline rule, then numbered entries `n. Source Title — Section Label`, each entry an active link using the existing `onActivate` callback. Below the footnotes, a `Colophon` line: `CLAUDE-SONNET-4-6 · 3.2K IN / 1.1K OUT · $0.014 · 4 SOURCES` — small-caps, hairline-separated, machine-register ink. The colophon appears only when `message.status === "complete"` and `trust_trail.run != null`.

**Streaming turns.** The machine body streams as before; `MessageFootnotes` and `Colophon` are absent. They appear on the `done` event when the status flips to `complete` (no layout reservation during streaming — D-7).

**Composer.** A flat writing desk: `--surface-1` background, a single hairline `border-top` rule, `border-radius: var(--radius-lg)` maximum. Context chips (pending context refs) render as small-caps text labels with a hairline border only, no fill. The send action is a quiet small-caps `SEND` text button (no icon); keyboard shortcut `Enter` unchanged.

**Mobile.** Same typography, same footnotes, same colophon. Nothing depends on bubble geometry.

---

## 3. Goals / Non-goals

### Goals

- **G1.** One user-turn register: `UserMessage.tsx` owns a single editorial presentation (no compact/expanded fork). One calling site, no `userPromptPresentation()` function.
- **G2.** One composer border-radius: `≤ var(--radius-lg)` everywhere in `ChatComposer.module.css`.
- **G3.** Footnote presenter: `components/chat/MessageFootnotes.tsx` is the sole owner.
- **G4.** Colophon owner: `components/chat/Colophon.tsx` (promoted to `components/ui/` when a second consumer materializes). Colophon data owner: `TrustRunOut` (extended with `total_cost_usd_micros`).
- **G5.** Citation click behavior is unchanged: `onActivate` → `ReaderSourceTarget` routing is untouched.
- **G6.** One new query, no new API endpoint (one JOIN added in `build_assistant_trust_trails`).
- **G7.** No element in the chat surface has `border-radius` > `--radius-lg`.

### Non-goals

- **N1.** No Oracle behavioral changes. `MachineText` never enters `app/(oracle)/**`. The `ReaderCitation.module.css` restyle (§4.5, S2) does affect Oracle reading-pane passage-citation markers because they share the same component; the superscript form is appropriate there and no Oracle code change is required. This is the only cross-surface effect.
- **N2.** No colophon on dossier revisions or Oracle readings. Those are explicitly named leaves (§4.4, §10).
- **N3.** No streaming layout reservation for the colophon. A brief height jump on `done` is acceptable (D-7).
- **N4.** No new API endpoint; `TrustRunOut` is extended in-place.
- **N5.** No change to the `CitationOut` schema. `toReaderCitationData` loses only the `color:` assignment line (deleted as part of the TS color chain — §9); `ReaderCitationData.color` and the `color` prop on `ReaderCitation` are removed.
- **N6.** No change to `AssistantTrustInspector` or the trust-trail disclosure mechanics.
- **N7.** No change to `ReaderCitation` interactive behavior (`HoverPreview`, `onActivate`, `href`).
- **N8.** The color assignment chain is eliminated entirely: `readerCitationColorForIndex`, `READER_CITATION_COLORS`, and `ReaderCitationColor` are deleted from `lib/conversations/readerCitation.ts`; the `color` field is removed from `ReaderCitationData`; `color: readerCitationColorForIndex(c.ordinal)` is removed from `toReaderCitationData` in `lib/resourceGraph/citations.ts`; `colorClass` const and `color` prop are removed from `ReaderCitation.tsx`. Only the index number shows (§9).

---

## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| User-turn register (full-measure, left rail, YOU kicker) | `UserMessage.tsx` (single mode) | `.userPromptCompact` / `.userPromptExpanded` dual-mode in `MessageRow.module.css` |
| Composer container shape | `ChatComposer.module.css` (≤ `--radius-lg`) | `border-radius: var(--radius-2xl)` |
| Context chip styling | `ChatComposer.module.css` `.pendingRef` (hairline, no fill) | `border: 1px solid var(--edge)` + `background: var(--surface-canvas)` chip |
| Send action | `ChatComposer.tsx` (small-caps text button "SEND") | `<Button iconOnly>` with `<ArrowUp>` icon |
| Inline citation marker | `ReaderCitation.tsx` (pure superscript `<sup>n</sup>`) | Colored chip badge with `background`, `padding`, colored border |
| Citation footnote list | `components/chat/MessageFootnotes.tsx` | (new; no prior owner) |
| Colophon display | `components/chat/Colophon.tsx` (promoted to `ui/` on second consumer) | (new; no prior owner) |
| Colophon data (cost) | `TrustRunOut.total_cost_usd_micros` via `build_assistant_trust_trails` | (new field; cost was in `llm_calls` only) |

### 4.2 User register

`UserMessage.tsx` collapses to a single presentation. The `userPromptPresentation(text)` function and the `compact`/`expanded` conditional are deleted. The rendered structure:

```tsx
<div className={styles.message} data-message-id={message.id} data-role="user">
  <div className={styles.userPrompt} role="group" aria-label="User prompt">
    <div className={styles.userKicker}>
      <span className={styles.userAttribution}>You</span>
      {/* Retry button if applicable */}
    </div>
    <span className={styles.userPromptBody}>{content}</span>
  </div>
  {/* error FeedbackNotice */}
  <span className={styles.timestamp}>{timestampLabel}</span>
</div>
```

New CSS for `.userPrompt`: `border-inline-start: 2px solid var(--accent-muted)`, `padding-inline-start: var(--space-3)`, full-width (`width: 100%`), no border-radius, no tinted background. `.userAttribution`: small-caps `YOU` — `font-variant-caps: all-small-caps`, `letter-spacing: var(--tracking-wider)`, `color: var(--accent-muted)`, `font-size: var(--text-xs)`. `.userKicker`: `display: flex; align-items: center; gap: var(--space-2); justify-content: space-between` (retry button on the right).

### 4.3 Composer

`ChatComposer.module.css` changes:
- `.composerShell`: `border-radius` → `var(--radius-lg)` (from `var(--radius-2xl)`); `background` → `var(--surface-1)` (from `var(--surface-2)`); replace `border: 1px solid var(--edge)` with `border-top: 1px solid var(--edge-subtle)` only.
- `.composerShell:focus-within`: `border-color` → `border-top-color: var(--accent)` only.
- Mobile override: remove `border-radius: var(--radius-xl)`.
- `.pendingRef`: remove `background: var(--surface-canvas)` and `border: 1px solid var(--edge)`; add `border: 1px solid var(--edge-subtle)`. Add `font-variant-caps: all-small-caps; letter-spacing: var(--tracking-wider)`.

`ChatComposer.tsx` send button change: replace `<Button variant="primary" size="md" iconOnly>` with `<Button variant="ghost" size="sm">SEND</Button>` (small-caps via CSS; no `iconOnly`; remove the `<ArrowUp>` icon; the `aria-label` for the active `sending` state becomes the button text). The stop/cancel button (square icon) is unchanged — it is a control action, not a compositional action, so the icon is appropriate.

### 4.4 Footnotes

`MessageFootnotes.tsx` receives `citations: ReaderCitationData[]` and the existing `onCitationActivate` callback. It renders:

```tsx
// components/chat/MessageFootnotes.tsx
// Only rendered when citations.length > 0
<div className={styles.footnotes}>
  <ol className={styles.footnoteList} aria-label="Sources">
    {citations.map((c) => (
      <li key={c.index} className={styles.footnoteEntry}>
        <FootnoteLink index={c.index} citation={c} onActivate={onCitationActivate} />
      </li>
    ))}
  </ol>
</div>
```

`FootnoteLink` renders `<a href={href}>` when `hrefForResourceActivation(c.activation)` returns a URL, and `<button>` when only an `activationTarget` exists (no URL) — mirroring the conditional already in `ReaderCitation.tsx:164-240`. Navigate via `onActivate(c.activation, c.target, event)`. Display: `n. {title}` with an em-dash + section label if `preview.meta[0]` is non-empty.

CSS: `border-top: 1px solid var(--edge-subtle)`, `margin-top: var(--space-4)`, `padding-top: var(--space-3)`. List: `list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-1)`. Entry: `font-size: var(--text-xs); color: var(--ink-muted)`. The title link: `color: var(--ink-muted); text-decoration: underline; text-underline-offset: 2px`. Section label: `color: var(--ink-faint)`.

Placement in `AssistantMessage.tsx` (after machine-hand cutover): inside the `MachineText` block, between `AssistantEvidenceDisclosure` and `AssistantTrustInspector`.

### 4.5 Inline citation marker restyle

`ReaderCitation.tsx` behavior is unchanged except for the removal of the `color` prop (§N-8, §9). Only the CSS changes: the `.citation` base class loses `display: inline-flex`, the fixed `min-width`/`height`/`padding`/`border`/`background`/`border-radius` declarations; it gains `display: inline; font-size: 0.75em; vertical-align: super; color: inherit; cursor: pointer; text-decoration: none`. Using `color: inherit` lets the marker pick up `--ink-machine` from the enclosing `MachineText` block (not `--ink-muted` which is the warm human register). The six color-variant classes (`.yellow`, `.green`, etc.) are deleted. `HoverPreview` continues to render on hover/focus with all existing data. Because `OracleReadingPaneBody.tsx` also renders `<ReaderCitation>`, this restyle visually transforms Oracle passage-citation markers to superscript too — intentional (N-1 scoped).

### 4.6 Colophon

`Colophon.tsx` is a pure display component. Props:

```tsx
// components/chat/Colophon.tsx
interface ColophonProps {
  modelName: string;           // from trust_trail.run.model_name
  inputTokens: number | null;  // from trust_trail.run.usage["input_tokens"]
  outputTokens: number | null; // from trust_trail.run.usage["output_tokens"]
  totalCostUsdMicros: number | null; // from trust_trail.run.total_cost_usd_micros (new field)
  sourceCount: number;         // message.citations.length (client-side)
}
```

Display format: `CLAUDE-SONNET-4-6 · 3.2K IN / 1.1K OUT · $0.014 · 4 SOURCES`. Formatting helpers (pure functions, unit-tested):
- Model: uppercase the model name as-is (it is already e.g. `claude-sonnet-4-6`; `.toUpperCase()`).
- Tokens: if non-null, format as `Xk` shorthand (`Math.round(n / 100) / 10 + "K"` if ≥ 1000, else `n` plain); omit entire token segment if both null.
- Cost: `totalCostUsdMicros / 1_000_000` formatted to `$X.XXX` (three decimal places); omit if null.
- Sources: `N SOURCE` / `N SOURCES` (handle singular); omit if `sourceCount === 0`.
- Join non-empty segments with ` · `.

CSS: `border-top: 1px solid var(--edge-subtle)`, `margin-top: var(--space-3)`, `padding-top: var(--space-2)`, `font-size: var(--text-xs)`, `font-variant-caps: all-small-caps`, `letter-spacing: var(--tracking-wider)`, `color: var(--ink-faint)`. No icons. Inherits `--font-machine` from the enclosing `MachineText` block.

Placement in `AssistantMessage.tsx` (after machine-hand cutover): inside the `MachineText` block, after `AssistantTrustInspector` (the very last child of the machine block). Only rendered when `message.status === "complete"` and `message.trust_trail?.run != null`.

### 4.7 Forward-refs (no code in this cutover)

- **Dossier colophon** (LI revisions): `machine-output-in-place-hard-cutover.md` (SPEC) renders `LibraryBrief` inline. A dossier `Colophon` at the foot of each revision reads from the revision's `llm_calls` attribution. Named leave — not built here.
- **Oracle reading colophon**: Oracle synthesis runs are `owner_kind='oracle_reading'` in `llm_calls`. Named leave — not built here. The oracle-shell-dissolution cutover restructures the oracle pane; the colophon can be added once that lands.
- **Dawn-write colophon**: `dawn-write-hard-cutover.md` (SPEC) claims `dawn_write` as a new `owner_kind`. The dawn block renders via `MachineText` origin `"Dawn"`. A generation colophon on the dawn artifact belongs there.

---

## 5. Data model / migration

**No Alembic migration.** Schema unchanged. One read-path extension only.

**`TrustRunOut` extension** (`python/nexus/schemas/conversation.py`): add `total_cost_usd_micros: int | None = None` to `TrustRunOut`. This field is the SUM of `llm_calls.total_cost_usd_micros` for all calls attributed to the run (`owner_kind='chat_run'`, `owner_id=run.id`).

**One new query in `build_assistant_trust_trails`** (`python/nexus/services/message_trust_trails.py:108`):

Two top-level import changes required first:
```python
# Line 9 — extend the existing sqlalchemy import:
from sqlalchemy import func, select, text

# Lines 13-25 — add LLMCall to the models block:
from nexus.db.models import (
    ...
    LLMCall,
    ...
)
```

Then the cost sub-query after the existing `run_ids` collection at line 108:
```python
# After the existing run_ids collection (line ~108):
cost_by_run: dict[UUID, int | None] = {}
if run_ids:
    for owner_id, total in db.execute(
        select(LLMCall.owner_id, func.sum(LLMCall.total_cost_usd_micros).label("total"))
        .where(LLMCall.owner_kind == "chat_run", LLMCall.owner_id.in_(run_ids))
        .group_by(LLMCall.owner_id)
    ):
        cost_by_run[owner_id] = total

# In the TrustRunOut(...) constructor (line ~496):
# Add: total_cost_usd_micros=cost_by_run.get(run.id),
```

**FE type** (`lib/conversations/types.ts`, `AssistantTrustTrail.run` interface): add `total_cost_usd_micros: number | null` to the inline run object (after `completed_at`).

---

## 6. API

**None** — no new routes, no shape change to existing endpoints beyond the `TrustRunOut` field addition. The field addition is additive and backward-safe (null when no llm_calls exist for a run, e.g. errored before provider call).

---

## 7. Frontend

### 7.1 Files created

```
components/chat/MessageFootnotes.tsx          # footnote list presenter
components/chat/MessageFootnotes.module.css   # footnote typography
components/chat/Colophon.tsx                  # colophon display (pure; promoted to ui/ on second consumer)
components/chat/Colophon.module.css           # colophon typography
lib/ui/correspondenceCutover.guards.test.ts   # negative gates (§13)
components/chat/MessageFootnotes.test.tsx     # browser: footnote render + click
components/chat/Colophon.test.ts              # unit: formatting helpers
components/chat/Colophon.test.tsx             # browser: render from props
```

### 7.2 Files modified

| File | Change |
|---|---|
| `components/chat/UserMessage.tsx` | Remove `userPromptPresentation()` and the compact/expanded fork; single editorial mode (§4.2); update CSS class references |
| `components/chat/MessageRow.module.css` | Delete `.userPromptCompact`, `.userPromptExpanded`, `.userCitationRow`; rewrite `.userPrompt`, `.userPromptHeader` → `.userKicker`, `.userAttribution`; add `.userPromptBody` prose measure |
| `components/chat/MessageRow.tsx` | No change (machine-hand owns `AssistantMessage` props; `UserMessage` change is internal) |
| `components/chat/AssistantMessage.tsx` | After machine-hand's MachineText block: add `<MessageFootnotes>` between `AssistantEvidenceDisclosure` and `AssistantTrustInspector`; add `<Colophon>` as last child of MachineText block (gated on `status === "complete"`) |
| `components/chat/AssistantEvidenceDisclosure.tsx` | Remove the local `useMemo(() => (message.citations ?? []).map(toReaderCitationData), [message.citations])` at line 28; accept a `citations: ReaderCitationData[]` prop from `AssistantMessage` instead. The memo is lifted to `AssistantMessage` level and shared with `MessageFootnotes`. |
| `lib/conversations/readerCitation.ts` | Delete `ReaderCitationColor`, `READER_CITATION_COLORS`, `readerCitationColorForIndex` (full color chain — N-8, §9) |
| `lib/resourceGraph/citations.ts` | Remove `color: readerCitationColorForIndex(c.ordinal)` from `toReaderCitationData` |
| `components/chat/ChatComposer.tsx` | Replace `<Button variant="primary" iconOnly>` with `<Button variant="ghost" size="sm">SEND</Button>` for the send action; remove `ArrowUp` import from lucide; update aria-label |
| `components/chat/ChatComposer.module.css` | Delete `border-radius: var(--radius-2xl)` and mobile `var(--radius-xl)` overrides; add `border-radius: var(--radius-lg)`; replace border with top hairline; restyle `.pendingRef` (§4.3) |
| `components/ui/ReaderCitation.module.css` | Restyle `.citation` to pure superscript; delete six color-variant classes (§4.5, §9) |
| `lib/conversations/types.ts` | Add `total_cost_usd_micros: number | null` to `AssistantTrustTrail.run` inline interface |
| `python/nexus/schemas/conversation.py` | Add `total_cost_usd_micros: int | None = None` to `TrustRunOut` |
| `python/nexus/services/message_trust_trails.py` | Add cost sub-query after `run_ids` collection; pass `total_cost_usd_micros` into `TrustRunOut(...)` constructor |

### 7.3 Adoption: AssistantMessage.tsx (post machine-hand state)

After machine-hand's S2 lands, `AssistantMessage.tsx` has this structure inside the `MachineText` block:

```
MachineText (block, origin "Assistant")
  ├─ ToolActivity
  ├─ AssistantEvidenceDisclosure
  └─ AssistantTrustInspector
```

This cutover adds:

```
MachineText (block, origin "Assistant")
  ├─ ToolActivity
  ├─ AssistantEvidenceDisclosure
  ├─ MessageFootnotes (new — citations derived from message.citations)
  ├─ AssistantTrustInspector
  └─ Colophon (new — gated on status===complete && run!=null)
```

The `citations` passed to `MessageFootnotes` are `(message.citations ?? []).map(toReaderCitationData)` — the same transformation already done inside `AssistantEvidenceDisclosure.tsx:28-30`. To avoid double-computation, the memoized `citations` array is lifted to the `AssistantMessage` level and passed to both children.

---

## 8. Key decisions

- **D-1. One editorial user mode.** *Rejected:* keeping compact/expanded and only restyling. The two-mode fork exists to signal "short message vs long message" — a concern the typography already handles (a two-line question needs no different container than a ten-line question; the block expands naturally). The fork adds CSS complexity and implements the right-align / bubble pattern this cutover explicitly deletes. One mode: full-measure, left-rail.

- **D-2. Composer as writing desk: hairline top, `--radius-lg`, no blob.** *Rejected:* keeping the surrounding border and only reducing the radius. The all-sides border asserts "this is a distinct floating element" — the glass-blob signal. A top-only hairline asserts "this is the writing surface at the foot of the page." The surface-1 fill (not surface-2) keeps it flush with the canvas. The radius-lg cap is the house maximum; the mobile override (`--radius-xl` → gone) is brought into compliance.

- **D-3. Send as small-caps "SEND"; during `sending=true` the button reads "SENDING".** *Rejected:* keeping the icon. The ArrowUp icon is the most legible UI-shorthand for "send message" — in a generic chat app. The Correspondence is not a chat app; it is a writing desk. A text button named "SEND" is explicit, editorial, and keeps the intent legible without iconographic convention. Enter shortcut unchanged (the keyboard sends, the button confirms). During `sending=true`: render `<Button variant="ghost" size="sm" disabled>SENDING</Button>` — same variant, no icon, no spinner; the existing stop/cancel square-icon button becomes the active abort control. Drop the `aria-label` on the button in this state — the visible text is the accessible name.

- **D-4. Footnotes over chip-strip.** *Rejected:* restyling chips to be smaller/less colorful. Chips are fundamentally inline UI elements; they interrupt the prose flow. The scholarly footnote (superscript in prose → list at foot) is the display form the reader apparatus already honors for source-authored citations. Using the same form for assistant-sourced citations unifies the two citation registers. Color is not meaningful on the inline marker (color was assigned by index, not by citation kind); it is removed.

- **D-5. Colophon data via `TrustRunOut` extension, not a new `MessageOut` field.** *Rejected:* a top-level `assistant_meta` field on `MessageOut`. The run data already lives in `TrustRunOut`; adding a separate `assistant_meta` would be a second home for the same provenance. Extending `TrustRunOut` with `total_cost_usd_micros` adds cost alongside the already-present model and usage in one coherent object. The field is null when no `llm_calls` row exists (error before provider call), which is the correct behavior: no colophon for failed runs.

- **D-6. Cost = SUM over all `llm_calls` for the run.** *Rejected:* cost from the first (or last) call only. A run may have retry attempts (`retry_count >= 0`); all retries incur cost. The SUM is the honest total. Each call has its own `total_cost_usd_micros` which already accounts for all token categories (input + output + cache + reasoning).

- **D-7. No space reservation for the colophon during streaming.** *Rejected:* a loading skeleton or min-height reservation. Reserving space requires knowing the rendered line height at streaming time, which creates a dependency on CSS metrics. The layout shift (a single line appears on `done`) is a one-time event per turn and is acceptable. The scroll anchoring hook (`useChatScroll.ts`) uses dynamic position measurement and will re-anchor naturally on the height change.

- **D-8. `source_count` is client-side.** *Rejected:* adding `source_count` to the backend `assistant_meta`. `message.citations.length` is already on the client (citations are part of `MessageOut.citations`). No backend round-trip needed.

- **D-9. Colophon is inside the MachineText block.** Machine-hand §4.4 says "consumers place machine *content* inside; interactive chrome stays outside." The colophon is non-interactive display content (no buttons, no cursor); it is machine content and belongs inside the block, inheriting `--font-machine`/`--ink-machine`. This means it is also covered by the `--rail-machine` left border of the MachineText block, which visually groups it with the prose it summarises.

- **D-10. `MessageFootnotes` receives `ReaderCitationData[]`, not `CitationOut[]`.** The `CitationOut` schema is a backend concern; `ReaderCitationData` is the FE display contract (§N-5). `MessageFootnotes` is a pure display component and should not depend on backend types. The `toReaderCitationData` adapter is called once at the `AssistantMessage` level.

- **D-11. `MessageFootnotes` goes inside the `MachineText` block.** Machine-hand §4.4 says "consumers place machine *content* inside; interactive chrome stays outside" (examples outside: Fork button, FeedbackNotice). `FootnoteLink` renders `<a>` or `<button>`, which is interactive. However, footnote links are *scholarly apparatus* of the machine text — their role is content navigation, not surface chrome. The machine-hand spec already carves out `TrustInspector` buttons as "desired in mono." `MessageFootnotes` belongs to the same class: its mono rendering reflects its status as apparatus to the prose it annotates, and placing it outside the `MachineText` block would break the visual grouping with the text it references. Consistent with the TrustInspector carve-out.

---

## 9. What dies (exhaustive)

**CSS declarations deleted from `MessageRow.module.css`:**
- `.userPromptCompact` block entirely (`lines 41-49`): `width: fit-content`, `max-width: min(72%, 46ch)`, `margin-inline-start: auto`, `padding`, `border: 1px solid var(--edge-subtle)`, `border-radius: var(--radius-md)`, `background: color-mix(...)`.
- `.userPromptExpanded` block entirely (`lines 51-58`): `width: 100%`, `padding`, `border: 1px solid var(--edge-subtle)`, `border-inline-end: 3px solid var(--accent-muted)`, `border-radius: var(--radius-md)`, `background: color-mix(...)`.
- `.userPromptHeader { justify-content: flex-end }` (`lines 60-66`) — the right-justify direction is deleted; the kicker lives in `.userKicker`.
- `.userCitationRow` block entirely (`lines 75-81`): `justify-content: flex-end`. Note: this class has no TSX callers at the time of this cutover — it is pre-existing dead CSS, confirmed by `rg 'userCitationRow' apps/web/src --include='*.tsx'` returning zero results.
- `.userPromptExpanded .userPromptBody` selector (`lines 92-98`) — the expanded-only typography override.

**CSS deleted from `ChatComposer.module.css`:**
- `border-radius: var(--radius-2xl)` in `.composerShell` (`line 16`).
- `border-color: var(--accent)` → replaced with `border-top-color: var(--accent)` on focus-within.
- Mobile override `border-radius: var(--radius-xl)` (`line 93` inside `@media (max-width: 640px)`).

**CSS deleted from `ReaderCitation.module.css`:**
- `.citation` base properties: `display: inline-flex`, `align-items: center`, `justify-content: center`, `min-width: 14px`, `height: 14px`, `padding: 0 3px`, `border: 1px solid transparent`, `border-radius: var(--radius-sm)`, `font-weight: var(--weight-semibold)`, `vertical-align: super`, `background: var(--surface-2)`, `transition: outline-color ...`.
- `.citation + .citation { margin-left: 6px }`.
- Color variant classes entirely: `.yellow`, `.green`, `.blue`, `.pink`, `.purple`, `.neutral` (the six color blocks that set `background`, `color`, `border-color`).

**JS/TS deleted:**
- `userPromptPresentation(text)` function in `UserMessage.tsx` (`lines 75-82`).
- The `presentation` variable and `data-presentation` attribute from `UserMessage.tsx`.
- The `collapseWhitespace` import in `UserMessage.tsx` (no longer needed).
- The `ArrowUp` lucide import in `ChatComposer.tsx` (send button redesigned; two call sites are removed: `leadingIcon={branchDraft ? <ArrowUp size={16} ...>}` at line 320 and `{branchDraft ? sendLabel : <ArrowUp size={18} ...>}` at line 336).
- `ReaderCitationColor` type, `READER_CITATION_COLORS` const, and `readerCitationColorForIndex` function from `lib/conversations/readerCitation.ts`.
- `color: ReaderCitationColor` field from `ReaderCitationData` interface in `lib/conversations/readerCitation.ts`.
- `color: readerCitationColorForIndex(c.ordinal)` assignment in `toReaderCitationData` in `lib/resourceGraph/citations.ts`.
- `colorClass` const and `color` prop from `ReaderCitation.tsx`.
- Import of `ReaderCitationColor` from `readerCitation` in `ReaderCitation.tsx`.
- `citations` memo from `AssistantEvidenceDisclosure.tsx` (lifted to `AssistantMessage`); the `citations` prop is now passed in.

**NOT deleted:**
- `ReaderCitation.tsx` behavior (onActivate, HoverPreview, href logic) — fully preserved.
- `ReaderCitation.module.css` focus-visible outline, pointer-events, and unavailable state.
- `.timestamp` CSS block in `MessageRow.module.css` — still used by user and system rows.
- `.userPrompt` base class — it stays but with new declarations.
- `.userPromptBody` for the user's text — kept, its measure styling is updated.
- `message.trust_trail` on the assistant message — fully preserved; only one field is added.
- The trust trail disclosure (`AssistantTrustInspector`) — fully preserved.
- The `BranchComposerHeader` (branch-reply mode header) — fully preserved.

---

## 10. Sibling cutovers and sequencing

- **`machine-hand-hard-cutover.md` (SPEC) — S3 prerequisite.** This spec's S3 cannot open before machine-hand S2 merges (see P-1). S0–S2 and S4–S6 are independent. Machine-hand wraps assistant content in `MachineText`, deletes `timestampLabel` from `AssistantMessage`, changes `.markdown { color: inherit }`, and owns `--font-machine`/`--ink-machine`/`--rail-machine` token definitions. `MessageFootnotes` and `Colophon` go inside the MachineText block that machine-hand creates. **Shared files:** `AssistantMessage.tsx` (machine-hand adopts it in S2; this spec adds inside the MachineText block in its S3). No concurrent edits; this spec's S3 opens after machine-hand S2 is merged.

- **`docent-hard-cutover.md` (SPEC) and `amanuensis-hard-cutover.md` (SPEC) — shared `AssistantMessage.tsx`.** Docent adds a `Walk` button in `messageActions`; amanuensis extends the active-tool-label switch and adds trust-trail write rows. This spec adds `MessageFootnotes`/`Colophon` inside the `MachineText` block (S3) and lifts the citations memo. All three regions are disjoint; all three sequence after machine-hand S2; merge additively (no ordering dependency among the three). No data-contract overlap.

- **`machine-output-in-place-hard-cutover.md` (SPEC) — named leave.** Deletes `LibraryIntelligencePane.tsx` and renders dossier inline via `LibraryBrief`. Dossier `Colophon` is a named leave in §4.7; this spec does not build it. Shared file: `LibraryIntelligencePane.tsx` (machine-hand S3 adopts it; this spec does not touch it). Disjoint scope.

- **`two-rooms-hard-cutover.md` (SPEC) — token coordination.** Owns Study/Press theme blocks. Machine-hand defines `--ink-machine`/`--rail-machine` values; #3 carries them. This spec uses `--edge-subtle` (`globals.css:137/172`) for hairline separator borders on footnotes and colophon. If two-rooms remaps `--edge-subtle`, re-verify the separator contrast in both rooms; both `MessageFootnotes.module.css` and `Colophon.module.css` reference it.

- **`dawn-write-hard-cutover.md` (SPEC) — disjoint scope.** Renders dawn block via `MachineText` origin `"Dawn"`. Colophon on the dawn artifact is explicitly deferred (§4.7). No shared file edits.

- **`chat-scroll-anchoring-hard-cutover.md` (BUILT).** Removing user bubbles changes every user-turn's height; adding the colophon adds height to completed assistant turns. The scroll anchoring hook (`useChatScroll.ts`) uses dynamic `overflowsBelow` measurement — no fixed height assumptions. **Coordination:** run the scroll anchoring e2e suite (`make test-e2e PLAYWRIGHT_ARGS="chat-streaming chat-composer"`) after S3 lands to confirm no regression. See R-1.

- **`reader-sidecar-consolidation-hard-cutover.md` (SPEC) — disjoint.** Owns `EvidencePaneSurface` and reader-connections. Does not touch `ReaderCitation.tsx` behavior; uses `MachineText` inline for Synapse rationale (already in machine-hand S3). The `ReaderCitation.module.css` restyle here affects both the in-prose markers (chat) and any usage inside sidecar apparatus renders — verify at build time that the sidecar still correctly shows citation numbers.

---

## 11. Slices (S0–S2, S4–S6 independently buildable; S3 blocked on machine-hand S2)

**S0 — BE cost field.** Extend top-level import at `message_trust_trails.py:9` to `from sqlalchemy import func, select, text`; add `LLMCall` to the `from nexus.db.models import (...)` block. Add `total_cost_usd_micros: int | None = None` to `TrustRunOut` (`conversation.py`). Add the GROUP BY cost sub-query after `run_ids` collection at `message_trust_trails.py:108` (§5 snippet). Update the `TrustRunOut(...)` constructor call at `line ~496`. Add `total_cost_usd_micros: number | null` to `AssistantTrustTrail.run` in `lib/conversations/types.ts`. Create `python/tests/test_message_trust_trails.py` with integration tests for `build_assistant_trust_trails` covering the cost field (populated when `llm_calls` row exists; null when none). *Verify:* `cd python && uv run pyright && uv run ruff check . && NEXUS_ENV=test uv run pytest -v -k test_message_trust_trails`. FE: `bun run typecheck` passes.

**S1 — Colophon component.** Build `components/chat/Colophon.tsx` and `Colophon.module.css`. Pure display; no integration yet. Build formatting helpers (`formatColophonTokens`, `formatColophonCost`, `formatColophonModel`) as named exports for unit testing. *Verify:* `Colophon.test.ts` (node unit): `formatColophonModel`: uppercase passthrough; already-uppercased input is idempotent; digits and hyphens preserved; `formatColophonTokens`: null → omit; 0–999 → plain number; 1000 → `1.0K`; 3200 → `3.2K`; both null omits segment; `formatColophonCost`: null omits; `14123` → `$0.014`; `1_000_000` → `$1.000`; null/empty `modelName` edge case (omit model segment). Segment join with ` · `. Singular/plural source. `Colophon.test.tsx` (browser): pass `modelName='claude-sonnet-4-6'` and assert rendered text is `'CLAUDE-SONNET-4-6'` (derived via `formatColophonModel`, not a string literal); renders nothing when all data null.

**S2 — Footnotes + inline marker restyle + color chain removal.** Build `components/chat/MessageFootnotes.tsx` + `MessageFootnotes.module.css`. Restyle `ReaderCitation.module.css` (§4.5, §9). Delete the color chain: `ReaderCitationColor`, `READER_CITATION_COLORS`, `readerCitationColorForIndex` from `lib/conversations/readerCitation.ts`; remove `color` field from `ReaderCitationData`; remove `color: readerCitationColorForIndex(c.ordinal)` from `toReaderCitationData`; remove `colorClass` const and `color` prop from `ReaderCitation.tsx`. Lift citations memo to `AssistantMessage` level; update `AssistantEvidenceDisclosure.tsx` to receive `citations: ReaderCitationData[]` prop. *Verify:* `bun run typecheck` green (TypeScript enforces color field removal). `MessageFootnotes.test.tsx` (browser): renders `n. Title — Section` entries; click calls `onActivate` with correct activation + target; empty citations renders nothing; `HoverPreview` on inline marker unchanged. `ReaderCitation.test.tsx`: no colored background style; `onActivate` fires; `aria-label` intact. AC-7: assert `vertical-align: super` computed style on an active (`<a>`) citation; assert `<sup>` renders for unavailable citation. Update `ReaderCitation` screenshot baseline.

**S3 — Colophon in AssistantMessage. (BLOCKED: requires machine-hand S2 merged first.)** Wire `Colophon` into `AssistantMessage.tsx` inside the `MachineText` block (which machine-hand S2 creates), gated on `status === "complete"` and `trust_trail.run != null`. Wire `MessageFootnotes` between `AssistantEvidenceDisclosure` and `AssistantTrustInspector`. Pass memoized citations from `AssistantMessage` level to both `AssistantEvidenceDisclosure` and `MessageFootnotes`. *Verify:* `bun run typecheck` (imports `MachineText` from machine-hand); `AssistantMessage.test.tsx` (browser): completed message shows colophon with correct model/token/cost/source text; streaming message shows no colophon; error message shows no colophon; citations produce footnote list; sending=true shows "SENDING" button text; no colophon without run data. Update `MessageRow` screenshot baseline.

**S4 — User register.** Remove compact/expanded fork from `UserMessage.tsx`. Rewrite `MessageRow.module.css` user styles (§4.2, §9). Remove `userPromptPresentation` function. *Verify:* `UserMessage.test.tsx` or `MessageRow.test.tsx` (browser): user prompt renders full-measure with `.userPrompt` left accent rail; no element has `margin-inline-start: auto`; no element has `border-radius: var(--radius-md)` on the user prompt container; retry button renders; timestamp renders on hover. Update `MessageRow` user screenshot baseline.

**S5 — Composer redesign.** Restyle `ChatComposer.module.css` (§4.3, §9). Change send button to small-caps text in `ChatComposer.tsx`. *Verify:* `ChatComposer.test.tsx` (browser, if exists) or focused smoke test: send button has text "SEND" and no ArrowUp icon; `.composerShell` does not carry `border-radius: var(--radius-2xl)`; context chips are text-label style. Update any composer screenshot baseline.

**S6 — Negative gate.** `lib/ui/correspondenceCutover.guards.test.ts` (§13). *Verify:* red before S1-S5 land; green after; deliberate injection confirms each assertion fires.

---

## 12. Acceptance criteria (testable)

- **AC-1.** No element inside `components/chat/` or `components/ui/` has `border-radius` exceeding `var(--radius-lg)` (gate §13-1).
- **AC-2.** `MessageRow.module.css` contains no `.userPromptCompact`, `.userPromptExpanded`, or `margin-inline-start: auto` in user prompt context (gate §13-2).
- **AC-3.** No `.module.css` under `apps/web/src/components` references `--radius-2xl` except for components that are explicitly not chat surfaces (gate §13-1).
- **AC-4.** A completed assistant message with citations renders an `<ol aria-label="Sources">` (the `aria-label` is on the `<ol>`, not a wrapping `<div>`) containing one entry per citation, each with the source title; clicking an entry calls `onCitationActivate` with the correct activation. Test: `screen.getByRole('list', { name: 'Sources' })` must find the element.
- **AC-5.** A completed assistant message with a non-null `trust_trail.run` renders a colophon containing the model name (uppercased) and source count; the colophon is absent on streaming and error messages.
- **AC-6.** Colophon renders `total_cost_usd_micros / 1_000_000` formatted to three decimal places (e.g. 14 123 → `$0.014`); absent when `total_cost_usd_micros` is null.
- **AC-7.** In-prose citation markers render as interactive elements (`<a>` or `<button>`) styled as superscripts via `display: inline; vertical-align: super`, or as `<sup>` when the citation has no href and no activationTarget (unavailable). They carry no background color, no `border-radius`, no `display: inline-flex`. Test by role: `getByRole('link', { name: /Open citation/i })` for normal citations; `getByRole('superscript')` only for unavailable citations (gate §13-3).
- **AC-8.** Citation click behavior is unchanged: `onCitationActivate(activation, target, event)` is called on both the in-prose `<sup>` click and the `MessageFootnotes` entry click.
- **AC-9.** `UserMessage.tsx` renders a single `.userPrompt` element with `border-inline-start` (left rail); no child element is right-aligned via `margin-inline-start: auto` or `text-align: right`.
- **AC-10.** `ChatComposer.module.css` `.composerShell` does not contain `--radius-2xl` or `--radius-xl` in any media query or base rule.
- **AC-11.** `bun run typecheck && bun run lint` pass; bundle budget (≤ 104 kB first-load) unchanged.
- **AC-12.** BE: `TrustRunOut` serializes `total_cost_usd_micros` as an integer when `llm_calls` records exist for the run, and null when none exist.

---

## 13. Negative gates (grep-able)

Implemented in `lib/ui/correspondenceCutover.guards.test.ts` (pattern: `readFileSync` over source, same tier as `machineHandCutover.guards.test.ts`).

**Gate 1 — No `--radius-2xl` in chat/composer.**
```bash
rg "radius-2xl" apps/web/src/components/chat/ apps/web/src/components/ui/
# Expected: zero matches
```
Assert: `ChatComposer.module.css` contains no `radius-2xl`; `MessageRow.module.css` contains no `radius-2xl`.

**Gate 2 — No right-aligned user prompt.**
```bash
rg "margin-inline-start:\s*auto" apps/web/src/components/chat/MessageRow.module.css
# Expected: zero matches in user prompt context
rg "userPromptCompact|userPromptExpanded" apps/web/src/components/chat/
# Expected: zero matches
```
Assert: neither class name appears in any `.tsx` or `.module.css` under `components/chat/`.

**Gate 3 — Citation chip CSS and TS color chain deleted.**
```bash
rg "display:\s*inline-flex" apps/web/src/components/ui/ReaderCitation.module.css
# Expected: zero matches
rg "background:\s*var\(--surface-2\)" apps/web/src/components/ui/ReaderCitation.module.css
# Expected: zero matches
rg "colorClass|ReaderCitationColor|readerCitationColorForIndex" apps/web/src --include="*.ts" --include="*.tsx" --glob "!*.test.*"
# Expected: zero matches in non-test source files
```
Assert: no `background` declaration and no color-variant class names (`.yellow`, `.green`, `.blue`, `.pink`, `.purple`) appear in `ReaderCitation.module.css`; `colorClass`, `ReaderCitationColor`, and `readerCitationColorForIndex` are absent from all non-test source files.

**Gate 4 — Colophon sole owner of formatting.**
```bash
rg "formatColophonTokens|formatColophonCost|formatColophonModel" apps/web/src --include="*.ts" --include="*.tsx"
# Expected: defined only in components/chat/Colophon.tsx + Colophon.test.ts; no other file re-implements
```

**Gate 5 — `userPromptPresentation` is dead.**
```bash
rg "userPromptPresentation" apps/web/src/
# Expected: zero matches
```

**Gate 6 — Footnote sole owner.**
```bash
rg "aria-label=\"Sources\"" apps/web/src/components/chat/
# Expected: only in MessageFootnotes.tsx
```

---

## 14. Test plan

**Unit (`.test.ts`, node):**
- `components/chat/Colophon.test.ts` — `formatColophonTokens`: null → omit; 0–999 → plain number; 1000 → `1.0K`; 3200 → `3.2K`; both null omits segment. `formatColophonCost`: null omits; `14123` → `$0.014`; `1_000_000` → `$1.000`. `formatColophonModel`: uppercase passthrough; already-uppercased input is idempotent; digits+hyphens preserved (e.g. `claude-3-5-sonnet-20241022` → correct uppercase); null/empty → omit model segment. Segment join with ` · `. Singular/plural source.
- `lib/ui/correspondenceCutover.guards.test.ts` — six grep assertions + color-chain absence assertion (§13).

**Browser (`.test.tsx`, Chromium, real providers + fetch-boundary mock):**
- `components/chat/MessageFootnotes.test.tsx` — renders citation list; click fires `onActivate` with correct activation/target; empty array renders nothing; `screen.getByRole('list', { name: 'Sources' })` finds the `<ol>` (AC-4).
- `components/chat/Colophon.test.tsx` — pass `modelName='claude-sonnet-4-6'`; assert rendered text is `'CLAUDE-SONNET-4-6'` (via `formatColophonModel`, not a literal); token segment formatted; cost formatted; sources count; null cost omits cost segment (AC-5, AC-6).
- `AssistantMessage.test.tsx` — completed turn: colophon present with model + cost + sources (AC-5, AC-6); footnotes present (AC-4); streaming: no colophon; error: no colophon; sending=true: button text is "SENDING". Update screenshot baseline.
- `MessageRow.test.tsx` (user row update) — AC-9; no right-align; left rail present; retry button; timestamp on hover. Update user-row screenshot baseline.
- `ReaderCitation.test.tsx` — active citation (`<a>`) has computed `vertical-align: super` (AC-7); no background style; `aria-label` intact; `onActivate` fires on click; `HoverPreview` opens on hover; unavailable citation renders `<sup>` (AC-7, AC-8). Update baseline.

**BE static (in `/home/niels/src/personal/nexus-web/python`):**
- `cd python && uv run pyright` — `TrustRunOut` field addition; `build_assistant_trust_trails` cost sub-query; import additions.
- `cd python && uv run ruff check .` — no lint regressions (top-level imports, not inline).
- Focused integration: `cd python && NEXUS_ENV=test uv run pytest -v -k test_message_trust_trails` — verifies `total_cost_usd_micros` is populated when `llm_calls` row exists; null when absent.

**Guards:** `bun run test:unit` (node project) — all six gate assertions green.

**Not run (house pattern, noted):** full e2e suite. **Exception:** scroll anchoring e2e (`make test-e2e PLAYWRIGHT_ARGS="chat-streaming chat-composer"`) is recommended after S3+S4 land — see R-1.

**Ladder:** S0 BE verify → S1 unit colophon → S2 browser footnotes + citation restyle → S3 browser AssistantMessage integration → S4 browser user register → S5 browser composer → S6 guard test → `bun run typecheck && bun run lint && bun run build`.

---

## 15. Files (created / modified / deleted)

**Created:**
```
apps/web/src/components/chat/MessageFootnotes.tsx
apps/web/src/components/chat/MessageFootnotes.module.css
apps/web/src/components/chat/MessageFootnotes.test.tsx
apps/web/src/components/chat/Colophon.tsx
apps/web/src/components/chat/Colophon.module.css
apps/web/src/components/chat/Colophon.test.ts
apps/web/src/components/chat/Colophon.test.tsx
apps/web/src/lib/ui/correspondenceCutover.guards.test.ts
python/tests/test_message_trust_trails.py
```

**Modified:**
```
apps/web/src/components/chat/UserMessage.tsx
apps/web/src/components/chat/AssistantMessage.tsx              (S3; post machine-hand S2)
apps/web/src/components/chat/AssistantEvidenceDisclosure.tsx   (citations prop lifted)
apps/web/src/components/chat/ChatComposer.tsx
apps/web/src/components/chat/ChatComposer.module.css
apps/web/src/components/chat/MessageRow.module.css
apps/web/src/components/ui/ReaderCitation.tsx                  (color prop + colorClass removed)
apps/web/src/components/ui/ReaderCitation.module.css
apps/web/src/lib/conversations/types.ts
apps/web/src/lib/conversations/readerCitation.ts               (color chain deleted)
apps/web/src/lib/resourceGraph/citations.ts                    (color: assignment removed)
python/nexus/schemas/conversation.py
python/nexus/services/message_trust_trails.py
```

**Screenshot baselines regenerated (not deleted — updated):**
```
apps/web/src/components/chat/__screenshots__/MessageRow.test.tsx/  (user row, assistant row)
apps/web/src/components/ui/__screenshots__/ReaderCitation.test.tsx/
```

**Deleted:** no files deleted. All deletions are declaration-level (CSS blocks, JS functions) within the files listed above.

---

## 16. Risks

- **R-1. Scroll anchoring regression from height changes (MEDIUM).** User-turn height changes (bubble removed, left-rail added, narrower at short lengths) and colophon addition (per-turn height added) both affect the `overflowsBelow` measurement in `useChatScroll.ts`. The hook is dynamic, not cached, so it should adapt. *Mitigation:* run `make test-e2e PLAYWRIGHT_ARGS="chat-streaming chat-composer"` after S3+S4 are merged; the existing 5-case regression suite covers bottom-follow, top-mode, branch-switch, and scroll-release. If a case regresses, the root cause is measurable (the hook's `scrollHeight`/`clientHeight` arithmetic), not structural.

- **R-2. ReaderCitation restyle reaches beyond chat (ACKNOWLEDGED, NOT A RISK).** `ReaderCitation.tsx` is used in `MarkdownMessage` (chat/dossier) and `OracleReadingPaneBody.tsx` (Oracle passage citations). The superscript restyle is appropriate and intentional on all these surfaces — confirmed in N-1. The behavioral contract (onActivate, HoverPreview) is unchanged; only CSS shape changes. *At build time:* run `rg "ReaderCitation" apps/web/src --include="*.tsx"` to confirm no additional call sites were added since this spec was written; inspect each if new ones appear.

- **R-3. Colophon layout shift on `done` (LOW).** On streaming completion, a new `Colophon` line appears. If the user is reading the bottom of a long turn, this shifts content up by one line height (~18 px). *Mitigation:* acceptable per D-7. The scroll anchor is in `bottom`-follow mode during streaming; on `done` the hook will re-pin to the bottom and the shift is invisible. For a user who has scrolled up to read, the shift is a single line and is not disorienting.

- **R-4. Cost display absent for older messages (LOW).** Messages whose runs pre-date this cutover have `llm_calls` rows but the read path was not populating `total_cost_usd_micros`. After S0 ships, all subsequent queries will populate cost. Historical messages will show `null` cost and the colophon will display model + tokens + sources without a cost segment. *Mitigation:* this is correct behavior (cost for historical runs is still computable; the query runs over all `llm_calls` regardless of when they were written); the colophon gracefully omits null segments.

- **R-5. `--edge-subtle` hairline color may shift in two-rooms (LOW).** The footnote and colophon separators use `var(--edge-subtle)` (`globals.css:137` dark / `:172` light). If `two-rooms-hard-cutover.md` remaps this token to a value that is too prominent, the hairlines would no longer be quiet. *Mitigation:* record in §10 coordination note; `--edge-subtle` is used for rule lines throughout the product, so a two-rooms change is unlikely to break hairline context; re-verify in both rooms if the palette shifts.

- **R-6. Send button accessibility regression (LOW).** The `ArrowUp` icon button with `aria-label` is a known accessible pattern. A text button labeled "SEND" must still be keyboard-activatable (it is — `<Button>` renders a `<button>` element) and must announce correctly to screen readers. *Mitigation:* per D-3, during `sending=true` the button renders `<Button variant="ghost" size="sm" disabled>SENDING</Button>` — the visible text is the accessible name; no separate `aria-label` is needed. Confirm this in the `ChatComposer.test.tsx` browser test (assert button text is "SENDING" when sending prop is true).

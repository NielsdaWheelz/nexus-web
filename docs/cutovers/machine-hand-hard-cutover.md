# The Machine Hand — machine-voice typography system — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. The old undifferentiated register is deleted, not toggled.

## One-line

Give machine-authored text its own honest typographic register — a machine face (`--font-machine`), a cooler ink (`--ink-machine`), a hairline attribution rail, and a small-caps origin signature — owned by **one** `MachineText` component, and route every machine-voice surface (chat assistant prose, tool/trust labels, Synapse rationales, the Library dossier) through it, so provenance that is *tracked* (`resource_edges.origin`, `llm_calls`) is finally *typeset*.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** JetBrains Mono is already loaded app-wide. `apps/web/src/app/layout.tsx:54-60` declares `JetBrains_Mono({ weight: ["400","500","600","700"], display: "swap", preload: false, variable: "--font-jetbrains-mono" })`; `globals.css:9-10` backs `--font-mono` with it. The Machine Hand adds **no new font download** — it declares a new *semantic* token over the same already-shipped face (D-2).
- **P-2.** The provenance data every signature needs already reaches the client. Chat: `ConversationMessage.role` + `created_at` (+ optional `trust_trail.run.provider`/`model_name`). Synapse: `ConnectionOut.origin` + `created_at` + `snapshot.excerpt` (rationale), rendered today at `ConnectionsSurface.tsx:307-311`. Dossier: `artifact.model_provider`/`model_name` + revision `created_at`/`promoted_at`. **No backend change, no migration, no new API** (D-8).
- **P-3.** The token layer is theme-forked in `globals.css`: a theme-invariant `:root` scale block (families/sizes) at `:1-156`, then `[data-theme="light"]` (`:159`), the `prefers-color-scheme: light` fallback (`:194`), and the dark defaults inside `:root` (`:123-155`). New machine tokens land in these same four places.

---

## 1. Problem (grounded diagnosis)

Doctrine says agents write as **named origins** — Synapse is "the first agent co-author of `resource_edges`" (`synapse-resonance-engine.md` §0), the dossier is a synthesis with a model attribution, the assistant is a distinct speaker. The database honors this: `EDGE_ORIGINS` enumerates `user | citation | system | note_body | highlight_note | synapse | document_embed` (`lib/resourceGraph/edges.ts:12-20`); `llm_calls` carries `owner_kind` / `llm_operation` / `provider` / `model_name`. **The screen does not.** Every one of these voices is set in the same warm Inter body face:

- **Chat assistant prose** renders through `AssistantEvidenceDisclosure.tsx:33` → `MarkdownMessage`, whose `.markdown` block declares only `color: var(--ink)` and inherits `--font-sans` (`MarkdownMessage.module.css:2-6`). The wrapping `.assistantBody` is `color: var(--ink)` and nothing else (`MessageRow.module.css:100-102`). The assistant reads exactly like the human's own note.
- **The Library dossier** renders the identical stack: `LibraryIntelligencePane.tsx:351-357` wraps the same `MarkdownMessage` in `.intelligenceBody`. Machine synthesis, human typography.
- **The Synapse rationale** — the agent's one-sentence "why this resonates" — is shown as a `.connectionMeta` span (`ConnectionsSurface.tsx:307-311`), a faint Inter line at `color: var(--ink-faint)` (`ConnectionsSurface.module.css:112-115`), typographically indistinguishable from the neighboring `kind` label.
- **Tool activity + trust labels** ("Searching web", the trust-trail summary) are Inter at `--ink-faint` (`MessageRow.module.css:156-163`), except the deep diagnostic `.trustCode` which already reaches for `--font-mono` (`:305-308`) — a lone, unsystematized instinct that machine output wants a machine face.

The consequence: the reader cannot tell, at a glance, whose hand set a block. A scholarly edition solves exactly this by setting its critical apparatus in a contrasting face. Nexus tracks provenance to the column but throws it away at the type layer. **There is no owner for "machine voice" as a typographic concern** — each surface hand-rolls faint-Inter, so any future correction (contrast, face, signature) must be made in N places and will drift.

---

## 2. Target behavior (user-facing)

- **Machine text is legibly not-you.** Assistant prose, the dossier, a Synapse rationale, and (forward) the dawn block are set in the machine face at a cooler ink. Your own notes, prompts, and highlights stay warm Inter. The contrast is quiet and typographic — no badges, no chips, no colored cards.
- **Each machine block is signed at its head.** A small-caps signature names the origin and, when the surface carries a time, the moment: `SYNAPSE · 06:14`, `ASSISTANT · 09:02`, `DOSSIER`. The signature is drawn only from the block's real provenance; a block with no honest origin gets no signature.
- **A hairline rail marks the block's left margin** — the apparatus gutter — so a machine block is scannable as a unit even before you read the signature.
- **Inline machine fragments** (a Synapse rationale inside a dense connection row) take the machine face + ink but no rail/signature — the row's existing origin marker (the `✦`) already signs them.
- **Both rooms hold.** The cooler ink passes WCAG AA in Study (day) and Press (night); machine text never becomes the low-contrast afterthought that faint-Inter is today.

---

## 3. Goals / Non-goals

### Goals

- **G1.** One owner: `components/ui/MachineText.tsx` is the sole component that applies the machine register. Every machine-voice surface composes it.
- **G2.** One token set: `--font-machine`, `--ink-machine`, `--rail-machine` (+ the signature is styled, not tokenized). Machine surfaces reference these tokens *only through* `MachineText.module.css`.
- **G3.** Signature = truth. The origin label and timestamp come from the surface's own provenance data (role/edge-origin/model), never a hardcoded or fabricated string (D-5).
- **G4.** Adopt the four in-scope surfaces (chat, Synapse, dossier) and record media-summary + dawn-write as forward-refs with exact composition notes.
- **G5.** A negative gate — modeled on the MediaImage owner gate — makes bypassing `MachineText` (using the machine tokens directly, or rendering `MarkdownMessage` outside a machine wrapper) a failing test.
- **G6.** Zero net new download; machine text is not first-paint LCP, so the `preload: false` on JetBrains Mono stands.

### Non-goals

- **N1. The Oracle is excluded.** The Oracle keeps its manuscript persona (`[data-theme="oracle"]` + `--font-oracle-body/display/fraktur`, `globals.css:248-262`). The Oracle is a *character* with a period voice; the Machine Hand is the workspace's *utilitarian machine* voice. They are different registers on purpose (D-1). MachineText never renders inside the `(oracle)` route group.
- **N2. Human voice is untouched.** User prompts (`UserMessage`, `.userPromptBody`), highlights, and note bodies stay `--font-sans`. The whole value is the *contrast*; touching both sides erases it.
- **N3. System/status text is out of scope.** `SystemMessage` (`.systemBody`, centered italic faint) and `FeedbackNotice` are app *status*, not machine *prose*; they keep their existing register.
- **N4. No new face, weight, or subset.** `--font-machine` resolves to the already-loaded JetBrains Mono stack. Forking to a bespoke machine face is a future token change behind this one seam (the reason a distinct token exists).
- **N5. No backend, no migration, no API, no `llm_calls` read path change.** All signature data already ships to the client (P-2).
- **N6.** No theme-fork work. Two-rooms (`two-rooms-hard-cutover.md`, sibling #3) owns Study/Press; this spec only *defines* the machine tokens' day/night values and hands them to #3 to carry (§10).

---

## 4. Architecture and final state

### 4.1 Final ownership map

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Machine face token | `--font-machine` (`globals.css` scale block) | ad-hoc `--font-mono` reach in `.trustCode` for prose |
| Machine ink token | `--ink-machine` (per-theme) | per-surface `var(--ink)` / `var(--ink-faint)` on machine prose |
| Machine rail token | `--rail-machine` (per-theme) | (new; no equivalent) |
| The machine register (font + ink + rail + signature) | `components/ui/MachineText.tsx` (+ `.module.css`) | `.assistantBody`, `.intelligenceBody`, `.connectionMeta`-as-rationale inline styling |
| Signature (small-caps origin + optional time) | `MachineText`'s internal `MachineSignature` | (new; provenance was untyped) |

### 4.2 The one component

```tsx
// components/ui/MachineText.tsx
import type { HTMLAttributes } from "react";

export interface MachineOrigin {
  /**
   * Honest origin label for the small-caps signature (e.g. "Assistant",
   * "Synapse", "Dossier"). MUST derive from the surface's own provenance
   * (message.role, edge.origin, model attribution) — never a literal invented
   * in the component. Also stamped onto `data-machine-origin` for the gate.
   */
  label: string;
}

export interface MachineTextProps extends HTMLAttributes<HTMLElement> {
  origin: MachineOrigin;          // required — provenance, always present (G3)
  timestamp?: string | null;      // ALREADY-FORMATTED display string ("06:14"); omit if the surface has no honest time
  timestampIso?: string | null;   // raw ISO instant (e.g. message.created_at) backing the <time datetime>; travels WITH `timestamp` (both or neither) — D-9
  variant?: "block" | "inline";   // default "block"
  showSignature?: boolean;        // block only; default true
  as?: "div" | "section" | "span";
}
```

- **block** (default): renders `<div>` (or `as`) with `styles.machine` + `styles.block` — machine font, machine ink, and a **left hairline rail** (`border-inline-start` in `--rail-machine`). When `showSignature`, a `MachineSignature` header (`ORIGIN · time`, small-caps) precedes `children`. Consumers place machine *content* inside; interactive chrome stays outside (§4.4).
- **inline**: renders `<span>` with `styles.machine` + `styles.inline` — machine font + ink only. No rail, no signature. `origin`/`timestamp` are still accepted (stamped to `data-machine-origin` for provenance/tests) but not rendered; the host surface already carries an origin marker.
- Both variants forward `...rest` (className merged, `data-*`, event handlers, refs) so a consumer keeps its own DOM contract (chat's `data-message-id`, `onMouseUp`) while delegating the register.

`MachineSignature` is internal (not exported): `<div class=signature><span class=origin>{label}</span>{timestamp ? <time class=time dateTime={timestampIso ?? undefined}>· {timestamp}</time> : null}</div>`. The `<time>` carries the machine-readable `datetime` from `timestampIso` (a real ISO instant), **not** the locale-formatted display `timestamp` — `"06:14"` / `"6:14 AM"` is not a valid `datetime` value, so a bare `dateTime` boolean or the display string would produce an invalid, a11y-hostile `datetime=""`. Contract (D-9): a caller that passes `timestamp` also passes `timestampIso`; a surface with no honest time passes neither.

### 4.3 Tokens (final values)

```css
/* globals.css — :root scale block (theme-invariant), after --font-mono (:9) */
--font-machine: var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo,
  Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

/* Dark defaults (:root, after --ink-faint :134)  — cooler + a step recessed vs --ink #ededef */
--ink-machine: #c4ccd6;
--rail-machine: color-mix(in srgb, var(--ink-machine) 34%, transparent);

/* [data-theme="light"] + prefers-light fallback — cool slate vs --ink #1a1a1c */
--ink-machine: #3c4a57;
--rail-machine: color-mix(in srgb, var(--ink-machine) 30%, transparent);
```

Contrast (verified against the surfaces machine prose actually sits on):
- Dark `#c4ccd6` on `--surface-1 #161618` ≈ **10.7:1**, on `--surface-canvas #0e0e10` ≈ **12.8:1** → AAA.
- Light `#3c4a57` on `--surface-1 #ffffff` ≈ **8.9:1**, on `--surface-canvas #fafaf7` ≈ **8.5:1** → AAA.

Both are cooler in *hue* than the neutral `--ink` (blue-gray / slate), one step down in luminance — apparatus, not primary. The signature reuses `--ink-machine`; small-caps + size subordinate it without a fourth token (deletion-positive).

### 4.4 The control-bleed rule (why we wrap content, not components)

`globals.css:301-303` sets `button { font-family: inherit }`, so any `<Button>` nested inside a machine container would inherit the mono face. Therefore **MachineText wraps machine *prose/content*, and consumers keep interactive/status chrome outside it.** In chat, the Fork button, `ForkStrip`, error/cancelled `FeedbackNotice`, the `StreamingGutterCue` (transient streaming indicator, `AssistantMessage.tsx:103`), and the `AssistantSelectionPopover` (floating selection action sheet, `:117-123`) all stay **outside** `MachineText`; `ToolActivity` + evidence body + `AssistantTrustInspector` go inside (trust-inspector buttons rendering in mono is *desired* — it already uses `--font-mono` for `.trustCode`). Because `StreamingGutterCue` currently sits *between* `ToolActivity` and the evidence body (`:103`), it is **moved up** to render immediately after the Fork actions and before the `MachineText` open tag, so the three wrapped children (`ToolActivity` + evidence body + `AssistantTrustInspector`) are contiguous inside one block with one rail and one signature. Keeping the cue outside also means the transient pending-state animation is never clipped by, or doubled against, the machine rail. This is also why the gate checks "`MarkdownMessage` renders inside `MachineText`", not "the whole row is machine".

---

## 5. Data model / migration

**None.** No schema, no Alembic revision, no column read added. Provenance already reaches the client (P-2); this is a token + one-component + adoption cutover.

## 6. API

**None.** No route, no BFF proxy, no `success_response` shape change (P-2, N-5).

---

## 7. Frontend

### 7.1 Files created

```
components/ui/MachineText.tsx          # the one owner (block + inline + MachineSignature)
components/ui/MachineText.module.css   # sole referencer of --font-machine/--ink-machine/--rail-machine
components/ui/MachineText.test.tsx     # Chromium: register applied, signature from provenance, inline vs block, control-bleed containment
lib/ui/machineHandCutover.guards.test.ts  # negative gate (models paneSurfaceCutover.guards.test.ts)
```

### 7.2 Adoption map (per-surface migration notes)

| Surface | File / site | Variant | `origin.label` (truth source) | `timestamp` (truth source) | Migration note |
|---|---|---|---|---|---|
| **Chat assistant turn** | `components/chat/AssistantMessage.tsx:81-146` | block | `"Assistant"` (from `message.role === "assistant"`) | `timestamp` = `formatDisplayDate(message.created_at, display, { hour:"numeric", minute:"2-digit" })`; `timestampIso` = `message.created_at` (D-9) | Wrap `<ToolActivity>` + `<AssistantEvidenceDisclosure>` + `<AssistantTrustInspector>` in one `MachineText` block. Keep the Fork button, `ForkStrip`, error/cancelled `FeedbackNotice`, `StreamingGutterCue` (move it up above the block, `:103`), and `AssistantSelectionPopover` (`:117-123`) **outside** it (§4.4). **Call `useRenderEnvironment()` here** to get `display` for `formatDisplayDate` — the hook is currently in the parent `MessageRow.tsx:56`; AssistantMessage now owns its own time formatting because the parent's `timestampLabel` is a **month/day** string (`MessageRow.tsx:69-71`), not the `hh:mm` the signature wants. **Delete** the bottom hover `.timestamp` render site only (`AssistantMessage.tsx:145`) — the signature head subsumes it; **keep** the `.timestamp` CSS (still used by user/system rows — see §9). **Remove** the now-unused `timestampLabel` prop from AssistantMessage's interface (`:46`) and its call site (`MessageRow.tsx:95`). **Delete** `.assistantBody { color: var(--ink) }` (`MessageRow.module.css:100-102`, assistant-only); ink now comes from the machine container. |
| **Chat markdown body** | `components/ui/MarkdownMessage.module.css:2-6` | — | — | — | Change `.markdown { color: var(--ink) }` → `color: inherit` so machine ink flows in. Safe: `MarkdownMessage` has exactly two consumers (verified), both machine (chat + dossier). Do NOT set a font on `.markdown`; it inherits `--font-machine` from the wrapper. |
| **Synapse rationale** | `components/connections/ConnectionsSurface.tsx:307-311` | inline | `"Synapse"` (from `connection.origin === "synapse"`) | omit — the `inline` variant renders no `<time>` (§4.2), so no formatting and no `useRenderEnvironment()` are needed here; the row's `✦` marker + `kind` label already sign it | Wrap only the rationale text in `MachineText` inline. Keep the `✦` `Pill` + `aria-label="Synapse connection"` + `kind` label as-is (the row's origin marker). `connection.createdAt` is a raw ISO string, so passing it as a display `timestamp` would violate the "already-formatted" contract; the inline variant needs none. |
| **Library dossier body** | `libraries/[id]/LibraryIntelligencePane.tsx:351-357` | block | `"Dossier"` (machine synthesis) | omit (the `StatusLine` already prints `Generated …`/model — passing a time would duplicate; demonstrates the optional `timestamp`) | Wrap `.intelligenceBody` `<MarkdownMessage>` in `MachineText` block. `StatusLine`, `GenerateDossierForm`, `RevisionHistory`, and the Chat button stay **outside**. |

### 7.3 Forward-refs (no code in this cutover)

- **Media summaries / claims** are not surfaced as standalone prose today — `document_embed_summary` is an aggregate status, not text (`lib/media/documentEmbeds.ts:102-104`); intelligence-unit `summary_md`/claims feed the dossier + Synapse dossiers server-side only. They already reach the reader *through* the dossier (which is now machine-set). **If** `machine-output-in-place-hard-cutover.md` (sibling #10) surfaces a media summary or notes-connections block inline, it renders that prose through `MachineText` block, origin `"Summary"` / `"Synapse"`. Recorded, not built.
- **Dawn-write** (`dawn-write-hard-cutover.md`, sibling #4) renders its morning block through `MachineText` block, origin `"Dawn"`, timestamp = the artifact's generation time. #1 lands before #4 (§10). Recorded, not built.
- **Reader connections** (`incoming-connections-reader-sidecar-*`, sibling #8) shows Synapse rationales (`ReaderDocumentMapConnectionsLens.tsx:143`, `row.excerpt`). That surface is #8's to own; it consumes `MachineText` inline the same way. Cross-ref only — not re-spec'd here.

### 7.4 Budget / CSP

No first-load impact: chat and the dossier are lazy pane bodies (not shell/LCP), so JetBrains Mono stays `preload: false` (P-1). Fonts are outside the ~104 kB JS budget; the new component is a thin wrapper (well under any budget move). Nonce-CSP is unaffected — no inline styles/scripts; tokens live in `globals.css`, styling in a CSS module.

---

## 8. Key decisions

- **D-1. The Oracle is excluded and stays a manuscript.** *Rejected:* one unified "generated text" face across Oracle + workspace. The Oracle is a period *character*; the Machine Hand is the workspace's *machine*. Collapsing them would flatten a deliberate persona into a utility register. The `(oracle)` fonts (`globals.css:259-261`) are untouched and MachineText never renders there.
- **D-2. The machine face is JetBrains Mono, exposed as a *distinct* token.** *Rejected:* (a) a new humanist/grotesque download — costs bytes for a face used only on non-LCP surfaces, and "a machine that types" reads most honestly as a mono/terminal lineage; (b) reusing `--font-mono` directly — that token *means* "code/keybindings/timestamps", a different concern; aliasing them would couple two unrelated future changes. A separate `--font-machine` (initialized to the same already-shipped stack) gives a one-line seam to fork the machine face later, and a token the gate can police.
- **D-3. Mono for long-form machine prose is intentional, not a compromise.** *Rejected:* mono only for short labels, Inter for bodies. The owner wants type-forward, AI-native, anti-slop; a monospace machine voice for AI output is a distinctive, honest editorial move and reads fine at prose leading (the face is built for extended code reading). The register *is* the message: this was set by a machine.
- **D-4. Cooler + recessed ink, defined per-room, contrast-first.** *Rejected:* a single theme-invariant machine ink (fails one room), or tinting toward the accent (reads as a link/alert). A neutral cool step passes AAA in both rooms and stays quiet.
- **D-5. Signature is provenance or nothing.** *Rejected:* a decorative always-on label. `origin.label` is required and must come from `message.role` / `edge.origin` / model attribution; a surface with no honest origin gets no signature (`showSignature={false}` or inline). `data-machine-origin` makes this auditable.
- **D-6. Wrap content, not components.** *Rejected:* applying the machine face to a whole message row. `button { font-family: inherit }` (`globals.css:302`) would bleed mono into every control. Wrapping only prose keeps controls in `--font-sans` and keeps the trust-inspector's already-mono diagnostics coherent.
- **D-7. The signature replaces the chat hover-timestamp *on assistant rows only*.** *Rejected:* keeping both. The bottom hover `.timestamp` and the head signature are the same information; shipping both is dashboard-itis. Delete the assistant hover render site; the signature carries the time. The `.timestamp` CSS and its use on user/system rows (out of scope, N-2/N-3) are untouched — only the assistant stops rendering it.
- **D-8. No backend / migration / API.** *Rejected:* a `machine_voice` flag or a signature-assembly endpoint. Every field already ships to the client; this is a pure presentation cutover.
- **D-9. Display time and machine-readable time are two props, paired.** The signature shows a locale-formatted `timestamp` (`"06:14"` / `"6:14 AM"`) but the `<time>` element's `datetime` attribute must be a valid machine-readable ISO instant, so the display string cannot double as it. *Rejected:* (a) a bare boolean `<time dateTime>` — renders an invalid `datetime=""` (HTML-invalid, a11y-hostile); (b) feeding the display string to `datetime` — locale-fragile and often not a valid time string. A separate `timestampIso` prop (`message.created_at`) backs the attribute; the two travel together (both or neither), and the `inline` variant renders no `<time>` at all, so Synapse passes neither.

---

## 9. What dies (exhaustive)

- `AssistantMessage.tsx:145` — the assistant's bottom hover `.timestamp` **render site** (`<span className={styles.timestamp}>`), plus the now-dangling `timestampLabel` prop on AssistantMessage and its pass-through at `MessageRow.tsx:95`. Subsumed by the signature (D-7). **The `.timestamp` CSS is NOT deleted:** the `.timestamp` block (`MessageRow.module.css:319-331`), its reduced-motion rule (`:151-153`), and `.message[data-role="user"] .timestamp` (`:18`) are still consumed by `UserMessage.tsx:70` and `SystemMessage.tsx:29` (both out of scope, N-2/N-3). Only the assistant *render* stops referencing the class; `MessageRow.tsx:69-71`'s `timestampLabel` computation stays (user + system still use it).
- `MessageRow.module.css:100-102` — `.assistantBody { color: var(--ink) }`. The class name may remain as a hook, but its color declaration is deleted; ink is inherited from the machine wrapper.
- `MarkdownMessage.module.css:5` — `.markdown { color: var(--ink) }` becomes `color: inherit`.
- The instinct-level, unsystematized "machine wants a machine face" is *promoted*, not deleted: `.trustCode`'s `font-family: var(--font-mono)` (`MessageRow.module.css:305-308`) is now the general case (its whole block is inside a MachineText) — leave it; it composes.
- No files are deleted (this is additive-plus-adoption); the deletions above are declarations, not modules.

---

## 10. Sibling cutovers and sequencing

- **#3 two-rooms** (`two-rooms-hard-cutover.md`) OWNS the theme token blocks (Study/Press). This spec **defines** `--ink-machine` + `--rail-machine` day/night values (§4.3) and their AAA contrast; #3 must **carry these tokens into both rooms** when it reworks the palettes. Coordination point, disjoint edits: this spec adds the tokens now; #3 keeps them present and re-tunes only if a room's surface colors move (re-verify contrast if so).
- **#1 lands before #4 and #10** (stated in the slate). Dawn-write (#4) and machine-output-in-place (#10) both *render through* `MachineText`; they must not ship until this component + tokens exist.
- **#8 reader-sidecar** owns the reader-connections surface that shows Synapse rationales; it consumes `MachineText` inline. Disjoint scope — do not re-spec its surface here.
- **#2 running-journal** (page furniture) and this spec both add small-caps type; no shared file. If both want a shared small-caps *primitive* later, that is a follow-up — not in scope; each ships its own styling now (the signature is internal to MachineText).

No sibling shares a file edit with this cutover except `globals.css` (append-only token additions) and the theme blocks coordinated with #3.

---

## 11. Slices (each independently buildable + verification)

- **S0 — Tokens + contrast gate.** Add `--font-machine` to the scale block and `--ink-machine`/`--rail-machine` to all three theme locations (dark `:root`, `[data-theme="light"]`, `prefers-color-scheme: light`) in `globals.css`. Ship the **required** `contrast.test.ts` in the same slice (pure file I/O over `globals.css`, same tier as the guard test) — it is the only CI enforcement of AC-7. *Verify:* `bun run build`; the token-presence assertion (guard test, S4) and the four `--ink-machine`×surface ratio assertions (`contrast.test.ts`) both green.
- **S1 — MachineText + CSS.** Build `components/ui/MachineText.tsx` (+ `.module.css`) — block/inline, `MachineSignature`, `...rest` forwarding, `data-machine-origin`. *Verify:* `MachineText.test.tsx` (Chromium): block renders rail + signature from `origin`/`timestamp`; inline renders neither; `showSignature={false}` suppresses head; a nested `<button>` inside a block keeps `--font-sans` (control-bleed containment); `className`/`data-*`/`onMouseUp` pass through.
- **S2 — Chat adoption.** Wrap the assistant content in `AssistantMessage.tsx` (move `StreamingGutterCue` above the block; keep `AssistantSelectionPopover` outside); delete the assistant hover `.timestamp` **render site only** (keep the shared CSS — §9) and the `.assistantBody` color; remove the unused `timestampLabel` prop + its `MessageRow.tsx:95` call site; add `useRenderEnvironment()` in AssistantMessage and format the signature time (`hh:mm`) via `formatDisplayDate`, passing `timestampIso={message.created_at}`. Flip `.markdown` to `color: inherit`. *Verify:* `AssistantMessage.test.tsx` / `MessageRow.test.tsx` — assistant prose is machine-set with an `ASSISTANT · …` signature and a valid `<time datetime>`; user **and system** rows still render their hover timestamp unchanged (Inter, `.timestamp` intact); Fork button/ForkStrip render in `--font-sans`. Update `MessageRow.test.tsx` screenshot baseline.
- **S3 — Synapse + dossier adoption.** Inline-wrap the rationale in `ConnectionsSurface.tsx`; block-wrap `.intelligenceBody` in `LibraryIntelligencePane.tsx`. *Verify:* `ConnectionsSurface.test.tsx` (synapse rationale is machine-inline, `✦` marker intact, user-origin rows untouched); `LibraryIntelligencePane.test.tsx` (dossier body machine-set, `DOSSIER` signature, StatusLine outside the register). Update screenshot baselines.
- **S4 — Negative gate.** `lib/ui/machineHandCutover.guards.test.ts` (§13). *Verify:* the gate is red before S1-S3 adoption and green after; introduce a deliberate direct-token use in a scratch module to confirm it fails.

---

## 12. Acceptance criteria (testable)

- **AC-1.** `MachineText` is the only component whose module CSS references `--font-machine`, `--ink-machine`, or `--rail-machine` (gate AC-1 in §13).
- **AC-2.** A completed assistant message renders its prose in `--font-machine`/`--ink-machine` with a head signature `ASSISTANT · <hh:mm>` (from `message.role` + `message.created_at`, with a valid ISO `<time datetime>`); the assistant renders no bottom hover `.timestamp` element.
- **AC-3.** A user message renders in `--font-sans`/`--ink` with no signature and no rail (contrast invariant preserved), and **still shows its hover `.timestamp`** (the shared class survives — §9).
- **AC-4.** A Synapse connection row shows its rationale in the machine face inline, retaining the `✦` `Pill` and `aria-label="Synapse connection"`; a `user`-origin row shows no machine styling.
- **AC-5.** The dossier body renders through `MachineText` block with a `DOSSIER` signature and **no** timestamp; `StatusLine`/`GenerateDossierForm`/`RevisionHistory` remain in `--font-sans`.
- **AC-6.** A `<Button>` nested inside a `MachineText` block keeps `--font-sans` (control-bleed containment).
- **AC-7.** `--ink-machine` passes WCAG AA (≥4.5:1) on `--surface-1` and `--surface-canvas` in both `[data-theme="light"]` and the dark default (numbers in §4.3).
- **AC-8.** No `MarkdownMessage` in `src/` renders outside a `MachineText` ancestor (gate); the Oracle route group contains no `MachineText` import (N-1).
- **AC-9.** Static gates green: `bun run typecheck`, `bun run lint`, `bun run build` (bundle budget), unit + browser suites, and the new guard test.

---

## 13. Negative gates (grep-able assertions)

Implemented as `lib/ui/machineHandCutover.guards.test.ts`, modeled on the existing `readFileSync`-over-source pattern in `lib/ui/paneSurfaceCutover.guards.test.ts` and the `globals.css`-reading `firstPaintCutover.guards.test.ts`. The MediaImage owner gate (`eslint.config.mjs:11-15,69-78`, `no-restricted-imports` for `next/image` outside `MediaImage.tsx`) is the ESLint analog; because the machine tokens are *CSS* (not imports) and the owner boundary is a *CSS module*, the enforced gate is a vitest source-grep (the house FE negative-gate form), stated here as assertions:

1. **Token owner.** No `*.module.css` under `apps/web/src` except `components/ui/MachineText.module.css` contains `var(--font-machine)`, `var(--ink-machine)`, or `var(--rail-machine)`.
2. **No inline-style bypass.** No `.tsx` under `src` contains `fontFamily: "var(--font-machine)"` / `--ink-machine` / `--rail-machine` in a `style={{…}}` object (machine register only via `MachineText`).
3. **Prose can't skip the register (closed-set + wrapper check).** A source-grep cannot see an *ancestor* wrapper — `AssistantEvidenceDisclosure.tsx` imports `MarkdownMessage` directly but is wrapped in `MachineText` one level up in `AssistantMessage.tsx`, so a naive "same file also imports MachineText" assertion would be permanently red. Instead the gate is a **closed set**: the only non-test files that import `@/components/ui/MarkdownMessage` are exactly `{ components/chat/AssistantEvidenceDisclosure.tsx, app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx }` (any new importer fails the gate → forces review), AND each is a known machine-voice site: `LibraryIntelligencePane.tsx` itself imports `MachineText`; `AssistantEvidenceDisclosure.tsx` is imported (as a component) **only** from `AssistantMessage.tsx`, which imports `MachineText`. (Enforces AC-8's render-tree invariant with grep-checkable clauses.)
4. **Oracle exclusion.** No file under `app/(oracle)/**` imports `MachineText` (N-1).
5. **Deletions stay dead.** `AssistantMessage.tsx` renders no element with `className={styles.timestamp}` and declares no `timestampLabel` prop; `MessageRow.module.css` `.assistantBody` no longer declares `color`; `MarkdownMessage.module.css` `.markdown` no longer declares `color: var(--ink)`. **Note:** the `.timestamp { }` rule in `MessageRow.module.css` is deliberately *present* (kept for the user/system rows) — the gate asserts the *assistant render site* is gone, not the CSS class.
6. **Tokens exist in every theme.** `globals.css` declares `--font-machine` once and `--ink-machine`/`--rail-machine` in each of the three theme locations (presence + count assertions).

---

## 14. Test plan

- **Unit (`.test.ts`, node):** `machineHandCutover.guards.test.ts` (§13, all six assertions). A small `contrast.test.ts` asserting the four `--ink-machine`×surface ratios ≥ 4.5 (parse hex from `globals.css`, compute WCAG relative luminance) so a future palette move that breaks a room fails CI (AC-7).
- **Browser (`.test.tsx`, Chromium — real providers, fetch-boundary mock):**
  - `MachineText.test.tsx`: block vs inline; signature present/suppressed; `data-machine-origin` stamped; `...rest` passthrough; nested-button control-bleed containment (AC-6); origin/timestamp rendered from props only (no fabrication); when `timestampIso` is supplied the `getByRole("time")` carries a valid ISO `datetime` attribute (not `""`), and the inline variant renders no `<time>` (D-9).
  - `AssistantMessage.test.tsx` / `MessageRow.test.tsx`: AC-2/AC-3; regenerate screenshot baseline (`__screenshots__/MessageRow.test.tsx`).
  - `ConnectionsSurface.test.tsx`: AC-4; `✦` + aria intact; user-origin untouched; regenerate baseline.
  - `LibraryIntelligencePane.test.tsx`: AC-5; regenerate the many existing dossier baselines.
- **Not run (house pattern, noted):** e2e / CSP — no route, DOM-contract, or header change; heavy suites deferred.
- **Ladder:** `bun run typecheck && bun run lint`; focused `MachineText`/`AssistantMessage`/`ConnectionsSurface`/`LibraryIntelligencePane` + the guard test; then `bun run test:unit && bun run test:browser`; `bun run build` (bundle budget).

---

## 15. Files (touched / created / deleted)

**Created:** `apps/web/src/components/ui/MachineText.tsx`, `MachineText.module.css`, `MachineText.test.tsx`; `apps/web/src/lib/ui/machineHandCutover.guards.test.ts`; `apps/web/src/lib/ui/contrast.test.ts` (**required** — sole AC-7 CI gate, S0); this spec.

**Modified:**
- `apps/web/src/app/globals.css` — add `--font-machine` (scale block) + `--ink-machine`/`--rail-machine` (dark `:root`, `[data-theme="light"]`, `prefers-color-scheme: light`).
- `apps/web/src/components/chat/AssistantMessage.tsx` — wrap machine content; move `StreamingGutterCue` above the block; delete the hover timestamp render site; remove the `timestampLabel` prop; add `useRenderEnvironment()` + signature time formatting (`timestamp` + `timestampIso`).
- `apps/web/src/components/chat/MessageRow.tsx` — drop the `timestampLabel={…}` pass-through to `AssistantMessage` (line 95); keep the computation (line 69-71) for user/system rows.
- `apps/web/src/components/chat/MessageRow.module.css` — delete only the `.assistantBody { color }` declaration. **Keep** `.timestamp` (block, reduced-motion rule, user `text-align`) — still used by user/system rows.
- `apps/web/src/components/ui/MarkdownMessage.module.css` — `.markdown` color → `inherit`.
- `apps/web/src/components/connections/ConnectionsSurface.tsx` — inline-wrap the rationale.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryIntelligencePane.tsx` — block-wrap `.intelligenceBody`.
- Screenshot baselines: `MessageRow`, `ConnectionsSurface`, `LibraryIntelligencePane` `__screenshots__`.

**Deleted:** no modules (declaration-level deletions only — §9).

**Memory (on merge):** add a Machine Hand project memory (token names, the one-owner rule, the control-bleed rule, the gate location).

---

## 16. Risks

- **R1. Mono fatigue on long dossiers/answers (D-3).** *Mitigation:* generous leading (inherit the existing `--chat-prose-line-height: 1.58`, `MessageRow.module.css:7`) and the machine measure; the face is designed for extended reading. If the owner rejects it in review, the fallback is *one* token change (`--font-machine` → a humanist face) behind the same seam — the adoption/gate/signature all stand. This is precisely why the token is distinct (D-2).
- **R2. Two-rooms re-tunes surface colors and breaks a room's contrast.** *Mitigation:* the `contrast.test.ts` (AC-7) fails CI on any `--ink-machine`×surface regression; §10 flags the coordination.
- **R3. Control-bleed regressions** as consumers restructure. *Mitigation:* AC-6 browser test + gate assertion 2 (no inline machine style) + the "wrap content, not components" rule stated at each adoption site.
- **R4. Streaming visual overlap** of the machine rail (`border-inline-start`) with the existing `StreamingGutterCue` (absolute `left: -8px`, `MessageRow.module.css:119-129`). *Resolution:* `StreamingGutterCue` renders **outside** the `MachineText` block (moved above it, §4.4), and the two anchor at different insets (rail inside padding, cue in the negative gutter). *Mitigation:* the browser test renders a `pending` assistant message and screenshots both to confirm they do not collide; adjust rail padding if they do.
- **R5. Screenshot-baseline churn** across `MessageRow`/`ConnectionsSurface`/`LibraryIntelligencePane`. *Mitigation:* expected and enumerated (§15); regenerate in the adopting slice so no baseline references a mixed old/new register mid-flight.
- **R6. Concurrent agent shares this checkout** (repo memory). *Mitigation:* stage explicitly, never `git add -A`; `globals.css` edits are append-only token additions to minimize conflict surface.

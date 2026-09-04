# The Flet — the third room

*Lothlórien lens. Caras Galadhon at dusk: lamps in the mallorn, silver trunks, green darkness, Ithildin that answers only to moonlight.*

---

## 1. Name & story

**The Flet.**

The Press is the night workshop; the Study is the day desk. Both are indoor rooms with a ceiling. The third room has no ceiling — a *flet* (Tolkien's own word, and genuine Old English *flet*, "the floor of a hall") is the platform built high in a mallorn where the Elves of Lórien sleep, eat, and keep watch. It is a room that happens to be in a tree. You climb a rope ladder, you sit down on scrubbed grey wood, and above you the leaves are gold and below you the lamps of Caras Galadhon are burning in the branches, and the reading is *better up here* — quieter, cooler, further from the ground. That is the whole pitch: the Flet is the room you go to when you want to be alone with a long text and not be reachable. The Press has ink and machinery; the Study has daylight and paper; the Flet has starlight, one lamp, and a very long night that does not seem to pass. Naming it "the Grove" or "the Wood" would name the place around it; naming it "the Flet" names *the floor you sit on to read*, which is the only part of Lothlórien this app is actually offering you.

Base pole: **twilight** — a third pole, not a variant of the other two. Not the Press's near-black ink-ground and not the Study's paper. A luminous green-grey darkness with light *inside* it, the way a night sky through leaves is never actually black. In value terms it sits above the Press (canvas Y≈0.013 vs the Press's ≈0.005) and it carries chroma where both other rooms carry none.

---

## 2. Complete token block

`color-scheme: dark` (native form controls, scrollbar arrows, and the UA's own widgets must render dark; the room is a night room even though it is lighter than the Press).

```css
[data-theme="elvish"] {
  color-scheme: dark;
```

### Surfaces — the mallorn ladder (bark in shadow, rising toward lamplight)

| Token | Value | Rationale |
|---|---|---|
| `--surface-canvas` | `#16201c` | Dusk under the canopy. Green-grey, desaturated (chroma ≈0.014 OKLCH) — *never* forest-green paint. Deliberately lighter than the Press's `#0e0e10` so the room reads as air, not ink. |
| `--surface-1` | `#1a2622` | First lift: the flet's scrubbed planking. |
| `--surface-2` | `#1f2d28` | Panels, sheets, code blocks. |
| `--surface-3` | `#253530` | Highest routine elevation: dialogs, toasts, popovers. |
| `--surface-hover` | `#2a3b35` | Warmed one step *and* one hue-degree toward gold — hover is lamplight falling on the plank, not just "lighter". |
| `--surface-active` | `#32453e` | Pressed: the lamp is directly overhead. |
| `--surface-sunken` | `#101815` | Wells, inset fields, track backgrounds — the gap between planks. |

Ladder rule: chroma rises *slowly* as lightness rises (0.012 → 0.020); pushing chroma up at low lightness is what makes dark greens go murky.

### Inks

| Token | Value | Rationale |
|---|---|---|
| `--ink` | `#e8e4d2` | Mallorn leaf in autumn — a warm pale gold-cream, not white. **Contrast vs canvas ≈ 13.1:1** (AAA). |
| `--ink-muted` | `#a8b6a8` | Silver-sage, the underside of the leaf. **≈7.9:1** (AAA) — muted ink here is still fully readable, which matters for an app read for hours. |
| `--ink-faint` | `#7a8f83` | Metadata, timestamps, disabled. **≈4.8:1** — deliberately kept above 4.5 rather than the usual decorative-faint. |
| `--ink-machine` | `#9fb6bc` | Galadriel's glass: cool water-blue-silver. Reads *cooler* than human ink, preserving the Machine Hand's whole point in a warm-inked room. **≈7.9:1**. |
| `--rail-machine` | `color-mix(in srgb, var(--ink-machine) 34%, transparent)` | Unchanged mechanism; inherits the cool cast. |
| `--ink-on-accent` | `#121a15` | Near-black green for text on gold fills. **≈7.9:1 against `--accent`**. |

### Edges

| Token | Value | Rationale |
|---|---|---|
| `--edge-subtle` | `#223029` | Row separators. Barely there — the Flet separates by rhythm, not by lines. |
| `--edge` | `#2c3a34` | Standard container hairline. |
| `--edge-strong` | `#4a5f55` | Emphasis, active field borders, table headers. **≈3.1:1 vs canvas** — clears the 3:1 non-text floor. |

### Accent — mallorn-gold, aged

| Token | Value | Rationale |
|---|---|---|
| `--accent` | `#c8a961` | Antique/brass gold, a greener cousin of the Press's `#c4a472`. **≈7.4:1 vs canvas** — safe as link text at body size, which `#ffd700`-class gold never is. |
| `--accent-hover` | `#dcbe7c` | The lamp turned up. |
| `--accent-active` | `#b0904c` | Pressed, dimmed. |
| `--accent-muted` | `color-mix(in srgb, var(--accent) 16%, transparent)` | Selected-row wash; translucent so it composes over any surface step. |
| `--ring` | `#cfe6e0` | **Moon-silver, not gold.** Focus is the moon; interaction is the lamp. Two light sources, never confused. ≈12.8:1 vs canvas, ≈9.9:1 vs `--surface-3`. |

### Status — chosen for hue-distance from a green field

| Token | Value | Rationale |
|---|---|---|
| `--success` | `#8fd6a6` | Niphredil: a pale star-flower green, far higher in lightness *and* chroma than any surface, so "green on green" can't collapse. ≈9.5:1. Always paired with a glyph — never colour alone. |
| `--warning` | `#e0a955` | Lamp-amber. ≈7.9:1. Distinct from `--accent` by chroma, and never used adjacent to it. |
| `--danger` | `#e2766b` | Rowan berry — a coral/terracotta red, deliberately pulled off pure red so it never forms a Christmas pair with the canvas. ≈5.6:1. |
| `--info` | `#9cc6d8` | Moon on Nimrodel. ≈8.9:1. Shares the cool family with `--ink-machine`, which is correct: information and machinery are the same voice. |

### Shadows — lantern light is diffuse, and nothing here is black

```css
--shadow-1: 0 1px 2px rgba(3, 10, 8, 0.34);
--shadow-2: 0 2px 6px rgba(3, 10, 8, 0.40);
--shadow-3: 0 6px 16px rgba(3, 10, 8, 0.46);
--shadow-4: 0 14px 34px rgba(3, 10, 8, 0.52);
--shadow-5: 0 28px 64px rgba(3, 10, 8, 0.58), 0 0 40px rgba(200, 169, 97, 0.05);
```
Rationale: the shadow colour is a deep green-black (`#030a08`), so elevation never punches a cold grey hole in a warm room. Only `--shadow-5` (modal/sheet, at most one on screen) adds the faint gold bloom — a lamp above the topmost surface. Blur radii are ~15% larger than the Press's at every step: light through leaves has no hard edge.

### Per-theme knobs

| Token | Value | Rationale |
|---|---|---|
| `--stroke-hairline` | `1.25px` | Between the Study's 1px and the Press's 1.5px. Halation on this canvas is real but weaker than on near-black; 1.25px is the measured middle. |
| `--body-font-size` | `var(--text-md)` | Reversed type on a dark ground needs the optical size-up, same reasoning as the Press. |
| `--tracking-body` | `0.006em` | Slightly less than the Press's 0.008em — the canvas is lighter, so counters close up less. |
| `--canvas-grain-opacity` | `0.05` | Higher than the Press's 0.035 because the grain here is *structured* (leaf tooth + star-field) and needs to be perceptible as texture, not noise. |
| `--canvas-grain-image` | see below | |

```css
--canvas-grain-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>\
<filter id='t'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/>\
<feColorMatrix values='0 0 0 0 0.82 0 0 0 0 0.86 0 0 0 0 0.78 0 0 0 0.55 0'/></filter>\
<pattern id='s' width='320' height='320' patternUnits='userSpaceOnUse'>\
<circle cx='34' cy='61' r='0.7' fill='%23dfeee8'/><circle cx='187' cy='23' r='0.55' fill='%23dfeee8'/>\
<circle cx='268' cy='142' r='0.8' fill='%23f2f7ee'/><circle cx='96' cy='214' r='0.6' fill='%23dfeee8'/>\
<circle cx='231' cy='287' r='0.5' fill='%23dfeee8'/><circle cx='12' cy='176' r='0.45' fill='%23dfeee8'/></pattern>\
<rect width='320' height='320' filter='url(%23t)' opacity='0.7'/>\
<rect width='320' height='320' fill='url(%23s)'/></svg>");
```
Two layers in one asset (the token holds one image): a fine leaf-tooth turbulence for paper feel, plus six sub-pixel stars per 320px tile. At 5% opacity the stars are not "sparkles" — they are the reason the dark never looks flat.

Namespaced ornament tokens, declared in the same block so `check-css-tokens.mjs` resolves them:
```css
--elvish-gold-a: #6b4a20;  --elvish-gold-b: #c99a4a;
--elvish-gold-hi: #f4e0b0; --elvish-silver: #cfe6e0;
--elvish-vine: url("data:image/svg+xml;utf8,<svg …240×12 tangent-endpoint vine…/>");
--elvish-corner: url("data:image/svg+xml;utf8,<svg …48×48 open branch…/>");
--elvish-tengwar-rule: url("data:image/svg+xml;utf8,<svg …baked outline path…/>");
--elvish-ornament: 1; /* global ornament dimmer, 0 in dense contexts */
```

---

## 3. Typography

**One new face only: Cormorant** (SIL OFL, variable woff2, self-hostable; ~40KB subset). High-contrast, hairline-serifed, genuinely calligraphic true italic — Art Nouveau in the letterform itself, which is the Alan Lee register. `--font-cormorant`, loaded via `next/font/local` exactly like the oracle faces, `preload: false`.

- **Display** — Cormorant 300/400 for anything ≥ `--text-lg`: pane titles, section openers, empty-state prose, settings room names, reader chapter openers. Never below 20px. Optical rule: `letter-spacing: 0.01em` at display sizes, `font-variant-numeric: lining tabular-nums`.
- **Body / UI** — **Inter, unchanged.** This is a deliberate refusal: the room changes light and material, not legibility. Every label, button, list row, form field and chat message stays in the same face at the same metrics as the other two rooms. A theme that swaps body type is a costume; a theme that swaps *light* is a room.
- **Long-form reading** — EB Garamond, already self-hosted, already the reader's face where the source calls for it. Nothing new.
- **Machine voice** — JetBrains Mono, unchanged geometry; only `--ink-machine` moves (to the cool `#9fb6bc`) and the attribution rail inherits it. The Machine Hand keeps its separation *and* gains from it: in a warm-gold room the cool machine ink is more legible as a distinct voice than it is in the Press.
- **Drop caps** — `.drop-cap` on the first paragraph of a long-form reading surface only, once per page: Cormorant 300 at 3.5 lines, `background: linear-gradient(150deg, var(--elvish-gold-a), var(--elvish-gold-b) 34%, var(--elvish-gold-hi) 50%, var(--elvish-gold-b) 66%, var(--elvish-gold-a)); background-clip: text; -webkit-text-fill-color: transparent;` with a `text-shadow: 0 0 0 var(--ink)` fallback layer so a failed clip degrades to plain ink rather than invisible text. The COLRv1 route (Bradley Initials) is noted and rejected: an extra font file for one glyph, versus a gradient we already have tokens for.

---

## 4. Tengwar strategy

**The hard rule: Tengwar never carries information. Delete every Tengwar pixel in the app and nothing becomes unusable, ambiguous, or less navigable. Every Tengwar mark is `aria-hidden="true"` and lives in a pseudo-element or a decorative SVG.**

**We ship no Tengwar webfont.** Tengwar fonts are transliteration fonts — Latin keystrokes mapped to tengwar by phonetic mode — so applying one to live DOM text produces glyph-soup, and the CSUR PUA route requires a keyboard map nobody will maintain. Instead: **Tengwar Annatar** (display) and **Tengwar Telcontar** (small/UI-scale) are installed **on the design machine only**, used to author a small fixed set of inscriptions, which are converted to outlines and shipped as SVG path data in the tokens above. Zero font bytes, zero transcription risk at runtime, and the glyph shapes are still real.

Correctness pipeline for every inscription, done once, by hand:
1. Compose the Sindarin or Quenya line (or English, in the English mode).
2. Transcribe in **Glaemscribe** (open-source, mode-file DSL) *and* **Tecendil**, independently.
3. Diff the two outputs. If they disagree, the line is wrong — rewrite it, don't fudge it.
4. Set in Tengwar Annatar, convert to outlines, hand-kern, export a minimal `<path>`, paste into the token.
5. Record the source phrase, mode, and both tool outputs in a comment beside the token, so the next person can re-verify.

Where Tengwar appears — exactly five places:
1. **Section-divider rule** on ornament Tier 2 surfaces: a horizontal band of *cropped* tengwar stems and bows used as pure repeating texture, like a Greek key. Nothing is meant to be read; legibility pedantry does not apply because there is no word there.
2. **Empty states** (Tier 3): one real, verified line — e.g. the shelf-empty state carries *"nothing yet grows here"* in the English mode — rendered as baked SVG at `--ink-faint`, with the English sentence set below it in Cormorant italic. The English is the message; the Tengwar is the illumination.
3. **The canopy watermark** on the switchboard header: a large, heavily cropped Tengwar flourish at 3% opacity, bled off the right edge.
4. **The Ithildin inscription** (§6) — one per app, on the reader's chapter-opener rule.
5. **The colophon / settings About surface**: the full, verified inscription at legible size, with its transcription, mode, and translation printed underneath in plain text. If we're going to do it, we show our work.

Explicitly refused: Tengwar numerals anywhere (they are stemless consonants; using them for page numbers, counts, or progress is exactly the fan-embarrassing move), Tengwar in buttons, labels, tabs, tooltips, or any string a user must parse, and any dynamic transcription of app content.

---

## 5. Ornament system

One motif, recombined: **an open, asymmetric, single-stroke branch** — never a closed knot, never interlace. It exists in three cuts: a 240×12 seamless horizontal **vine tile** (first and last path points share a y, handles tangent to horizontal, so it repeats without a kink), a 48×48 **corner branch** that grows inward and stops, and a 10×10 **leaf notch** terminal.

**Techniques, per element:**
- **Vine rules / dividers** — `mask-image: var(--elvish-vine); mask-repeat: repeat-x; mask-size: 240px 12px;` over a `background: linear-gradient(90deg, transparent, var(--edge-strong) 12%, var(--edge-strong) 88%, transparent)`. Masking a gradient (rather than tiling a coloured image) means the rule fades at both ends and recolours from tokens for free.
- **Corner ornament** — **four absolutely-positioned 48px elements**, each `background-image: var(--elvish-corner)`, opposite corners mirrored with `transform: scaleX(-1)` / `scaleY(-1)`. Deliberately *not* `border-image`: `border-image-repeat: round` renders inconsistently across engines and `mask-border` is unimplemented in Firefox. One asset, four placements, zero cross-browser risk.
- **Gold ring** (avatar/badge/primary-CTA frame) — the transparent-border double-background trick: `border: 2px solid transparent; background: linear-gradient(var(--surface-1),var(--surface-1)) padding-box, conic-gradient(from 210deg, var(--elvish-gold-a), var(--elvish-gold-b), var(--elvish-gold-hi), var(--elvish-gold-b), var(--elvish-gold-a)) border-box;`. Conic, because real metal shows a light source sweeping around a form; flat gold always reads as paint.
- **Leaf notch** — a 10px `::before` on the leading edge of a row, `background: var(--accent); mask: var(--elvish-leaf);`, `opacity: 0` at rest.

**Restraint hierarchy** — the whole system is a dimmer, `--elvish-ornament`:

- **Tier 0 — none.** Reader body text, chat prose, library/list rows in bulk, tables, form fields, anything repeating more than ~12 times on screen. Rows get *colour and hairline* only. The artifact stays sovereign.
- **Tier 1 — whisper.** Scrollbar, focus ring, hover glow, the selected-row gold rule, the search-field underline. Ornament expressed only as light and hairline weight.
- **Tier 2 — accent.** Pane header divider, section openers, sheet top edge, player progress. One vine rule, one gold mark, nothing else.
- **Tier 3 — full.** Empty states, the settings appearance pane, the About/colophon page, reader chapter openers, the switchboard header. Corner branches, watermark, baked Tengwar. Fewer than eight surfaces in the entire app.

**Graceful degradation.** Any dense container sets `--elvish-ornament: 0`, and every ornament multiplies its opacity by it — one variable turns the whole system off for a region without deleting DOM. `@container (max-width: 480px)` drops Tier 3 to Tier 2 (leading corner only). Under `@media (forced-colors: active)` and `prefers-contrast: more`, all ornament opacity goes to 0 and `--canvas-grain-opacity: 0`.

---

## 6. Light & motion

**The governing idea: attention is light.** In the Flet there are exactly two light sources and they never mix roles — the **lamp** (warm gold, `--accent`) means *interaction*, and the **moon** (cool silver, `--ring`) means *attention/focus*. Hover lights the lamp; keyboard focus brings the moon.

- **Hover** (`--duration-fast`, `--ease-out`): `--surface-hover` step, plus a lamp-glow — `radial-gradient(120px 40px at 12px 50%, color-mix(in srgb, var(--accent) 9%, transparent), transparent)` anchored at the row's leading edge, so the light has a source and a direction rather than uniformly brightening a box. The leaf notch fades from 0 → 0.9.
- **Focus-visible**: a double ring — `outline: 2px solid var(--ring); outline-offset: 2px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent) inset;` — moonlight outside, one hairline of lamplight inside. Always `border-radius: var(--radius-sm)` — nothing in this room gets a blunt square corner.
- **Active**: `--surface-active`, no scale transform, `--duration-fast`. Pressing is not a bounce.

**Ithildin reveal.** One pattern, used on exactly two surfaces (the pane-header vine rule, and the reader chapter-opener inscription). The ornament is drawn at rest in `--edge-subtle` — present in the DOM, perceptually silent. On `:focus-within` of the owning pane (not hover — *attention*, not passing the mouse), over `--duration-base` with `--ease-out`, it fades to `--elvish-silver` and gains a two-radius glow: `filter: drop-shadow(0 0 5px color-mix(in srgb, var(--ring) 85%, transparent)) drop-shadow(0 0 14px color-mix(in srgb, var(--ring) 45%, transparent));` — `drop-shadow`, not `box-shadow`, so the bloom follows the glyph alpha instead of the bounding box. Tight+wide is what makes it read as moonlight rather than a CSS glow. Cheaper variant if paint cost bites: crossfade a pre-blurred duplicate layer instead of animating `filter`.

**The focused pane is the lit one.** The pane with focus-within sits at `--surface-1`; unfocused panes drop a half-step toward `--surface-canvas` and desaturate 4%. Lamps in the leaves: you can see at a glance which branch you are on, and it costs nothing but two background values.

**Reduced motion.** `@media (prefers-reduced-motion: no-preference)` wraps every transition. The reduced-motion path **keeps every end state and removes only the interpolation** — Ithildin still lights, the notch still appears, the lamp-glow still falls; they just arrive instantly (`transition: none`). Nothing disappears, nothing loses meaning. The grain and star-field never animate for anyone. There is no shimmer sweep, no looping animation, and no particle anywhere in this theme.

---

## 7. Signature moments

1. **Pane header divider — the Ithildin rule.** Every pane's header sits above a vine rule that is essentially invisible. Focus the pane and it silvers and blooms over 240ms. Nine panes open, one is lit. This is the single most distinctive thing in the room and it is also *functional*: it answers "where am I typing?".
2. **Library `ResourceRow`.** No cards, no change to geometry — `--stroke-hairline: 1.25px` in `--edge-subtle`, and on hover a leading-edge leaf notch in gold plus the directional lamp-glow. Selected rows take a 2px gold left rule terminating in the leaf. Editorial rhythm intact; the light does the work.
3. **Switchboard search field.** The underline is one vine stroke, `mask-size: 0% 100%` at rest showing only a hairline; on focus it *grows outward from the caret* to full width in 200ms via `mask-size` + `mask-position`. The command surface literally sprouts.
4. **Reader chapter opener.** Cormorant gradient drop cap, a baked Tengwar inscription in the margin at `--edge-subtle` that lights on focus-within, and nothing else — the body text is untouched Garamond on `--surface-canvas`. Ornament stands at the door and does not come in.
5. **Scrollbar as mallorn branch.** Track `--surface-sunken` with a `--edge-subtle` hairline; thumb a `linear-gradient(var(--elvish-gold-b), var(--elvish-gold-a))` capsule with a 2px `--surface-canvas` border so it reads as inset in the wood. Set via both `scrollbar-color` and `::-webkit-scrollbar-*` — in 2026 neither alone covers everything.
6. **Selection.** `::selection { background: color-mix(in oklch, var(--accent) 28%, transparent); color: var(--ink); }` set globally — and `MachineText.tsx`'s two hardcoded `::selection` pairs get tokenized in the same pass, because a selection that turns brown mid-machine-block is exactly the seam that kills the illusion.
7. **Empty states.** The one place ornament is the content: four corner branches, a verified baked Tengwar line, and the English beneath it in Cormorant italic at `--ink-faint`. An empty shelf in the Flet should feel like a place, not an error.
8. **Player progress.** The elapsed fill is a gold gradient; the leading edge carries a 6px silver bloom that travels with it. The lamp moves along the branch. Track is `--surface-sunken`; nothing else changes.
9. **Toasts.** `--surface-3`, `--shadow-4`, and a 1px gold top rule that draws left-to-right in 180ms as it enters. The toast is the *only* element in the theme permitted `backdrop-filter: blur(8px)` — one non-scrolling element, per the paint-cost rule.
10. **The settings appearance pane.** Three room cards, each rendering a three-line miniature of its own room in its own colours and its own hairline weight — the Study, the Press, and the Flet, with the Flet's miniature carrying one lit lamp. Choosing a theme should look like looking through three doorways.

---

## 8. What we refuse

1. **No closed Celtic/Norse interlace, ever.** Knotwork reads Dwarvish and generic-fantasy. Our motif is open, asymmetric, botanical, and terminates — it grows toward a margin and stops.
2. **No Christmas.** Saturated hue-wheel green plus saturated hue-wheel gold is a wreath. Our green is desaturated toward moss/pine (chroma ≤0.02 on every surface), our gold is aged toward brass (`#c8a961`, not `#ffd700`), and our red is pulled to coral (`#e2766b`). The pairs never sit adjacent at full strength.
3. **No casino.** No looping shimmer, no shine sweep on every heading, no glitter, no particles. The only animated light in the theme responds to a user action and stops.
4. **No Skyrim mod.** No embossed bevels, no hammered-metal skeuomorphism, no carved-stone textures, no parchment behind every surface, no scroll-shaped or banner-shaped buttons, no 9-patch ornate frame on every panel. Flat confident colour, one motif, four placements.
5. **No fantasy serif at body size.** Cormorant below 20px is unreadable; Inter carries every functional string in the app. A theme that hurts to read is a costume.
6. **No fake runes.** Either real, hand-verified, double-tool-checked Tengwar as baked outlines, or nothing. No glyph-soup, no naive Latin→Tengwar substitution — the single most fan-recognisable error available.
7. **No Tengwar that means anything.** If it can be deleted without loss, it may stay. If a user needs it to operate the app, it is a bug.
8. **No green-on-green status.** Success is separated from the field by lightness *and* chroma *and* an accompanying glyph; colour is never the sole signal for any state.
9. **No ornament in dense views.** More than ~12 repeats on screen and `--elvish-ornament` goes to 0. Ornament that is everywhere stops being ornament and becomes noise.
10. **No touching identity.** The asterism mark, favicon, apple-icon, OG image, and PWA manifest stay brand-coloured. The room is not the product.

---

## 9. Readability & accessibility commitments

Non-negotiable, and testable:

- **Body ink ≥ 13:1** on `--surface-canvas` and ≥ 11:1 on every surface step. **Muted ink ≥ 7:1. Faint ink ≥ 4.5:1** — no metadata in this app falls below AA, ever.
- **`--accent` is legible as body-size link text (7.4:1)**, so links never need underlining-plus-colour as a crutch — though they keep their underline anyway.
- **Focus ring is an independent token** (`--ring`, silver) at ≥3:1 against every surface it can land on, 2px, with 2px offset, never suppressed by ornament. The existing `EntrySurfaces.browser.test.tsx` contrast suite should have `"elvish"` added to its `it.each` array — the theme is not done until it passes the same WCAG assertions as dark and light.
- **Type metrics for functional text are identical to the other two rooms.** Only `--body-font-size`, `--tracking-body`, and `--stroke-hairline` fork, each for a stated optical reason.
- **All ornament is `aria-hidden`**, lives in pseudo-elements or decorative SVG, and is removed entirely under `forced-colors: active` and `prefers-contrast: more` (along with the grain).
- **`prefers-reduced-motion` preserves every end state.** Reduced motion removes interpolation, never information.
- **Grain ceiling 5%,** and it is suspended behind reading surfaces exactly as the Press's is, so long-form text never sits on texture.
- **One `backdrop-filter` element** in the whole theme. No `filter` on anything that repaints per scroll frame.
- **Zero raw colour literals outside `globals.css`** — the theme needs no exemption in `check-css-tokens.mjs`, which means it repaints every one of the app's surfaces with no missed seams.

---

## 10. Three OOD wildcards

**1. The Ithildin obeys the actual moon.** Ithildin can only be seen by moonlight. So compute the real lunar phase client-side from the date (a dozen lines, no network, no dependency) and scale the Ithildin reveal's peak opacity and glow radius by it: `--elvish-moon: 0.15` at new moon, `1.0` at full. On a dark-moon night the pane rules barely silver when you focus them; at full moon they bloom. Nothing functional depends on it, nobody is ever told, and a user who reads daily for a month will one evening notice that the app has been quietly keeping a calendar. Cost: one number.

**2. The room outside time.** Lothlórien is where time does not pass. The star-field in `--canvas-grain-image` is seeded *once per session* — a different arrangement of stars each time you arrive — and then **never changes for the entire session, no matter how long it runs**. No animation, no drift, no day/night shift, no "good evening" greeting, no relative timestamps ticking over in the chrome. Every other room in the app can tell you what time it is; the Flet refuses. You leave and re-enter and the sky is different, and you will not be able to say when it changed.

**3. The wood remembers where you walk.** The strange one. Long-dwell reading positions leave a permanent, almost imperceptible mark on the margin rail — a hairline 3px tall at `--edge` +6% lightness, accumulated locally (IndexedDB, per resource, never synced, never shown as a number). Re-open a book you have read three times and the rail carries a faint worn path down its length, brighter where you stopped and re-read, blank across the chapters you skimmed. It is not a progress bar; it does not scrub, click, or tooltip; it cannot be turned into a metric. It is the groove worn in a wooden step by people going up to read, and it is the only element in the entire design system that is *authored by the user without their knowing it*.

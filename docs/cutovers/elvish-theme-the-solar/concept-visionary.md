# The Conservatory — the third room

*Lens: the Uttermost West. Research/design only; no product code changed.*

---

## 1. Name & story

**The Conservatory.**

The Press is where the night work happens: near-black, grained, reversed type, gold struck on lead. The Study is the day desk: paper, brown-gold, hairlines like ruled vellum. Both are interior rooms with no weather in them — that is exactly why they are trustworthy. The third room is the one with a **sky in it**: a glass-roofed conservatory off the back of the press, where the green things are kept alive through the winter and where light is a material rather than a setting. It is the only room in the building that knows what time it is. Its ground is the dark of leaf-shadow under glass; its light is antique brass and, after dusk, the cold silver that only shows up when everything else has gone quiet. The elvish register is not a costume laid over this — it *is* the room's logic: things that grow are open, asymmetric, and branching (never knotted or closed); metal is aged rather than new; and the writing on the walls is in a hand you are not asked to read, only to feel the discipline of. Two rooms are places; the Conservatory is a place *and an hour*. It drifts — moss-green at morning, leaf at noon, pine at dusk, mithril-green past midnight — but only in hue. Its contrast never moves, because the one promise this room makes is the same as the other two: you can read in it for six hours without noticing it.

Settings label: **Conservatory — glass roof, green shade, brass and starlight.** Its brass plaque, and only its plaque, is written in Tengwar.

---

## 2. Complete token block

**Pole:** a third pole — *twilight*, not dark and not light. Dark in **value** (canvas L≈16%), chromatic in a way neither existing room is, and **hour-drifting in hue only**. `color-scheme: dark`.

**The drift mechanism.** Two scalar custom properties are set on `<html>` (SSR from the server clock, refreshed every 6 min client-side): `--hour-hue` (surface hue) and `--hour-gold` (accent hue). Every token is authored in `oklch()` with **lightness and chroma hard-coded** and only hue interpolated. Contrast ratio is a function of L; L never moves; therefore **no drift can ever break a contrast commitment**. Hex values below are the *noon anchor* (`--hour-hue: 152`, `--hour-gold: 85`) and are the literal fallbacks shipped for the no-JS/SSR-first paint.

| Drift phase | `--hour-hue` | `--hour-gold` | feel |
|---|---|---|---|
| 05–09 dawn | 138 (moss) | 92 (pale brass) | cool, waking |
| 09–16 noon | 152 (leaf) | 85 (amber-brass) | the anchor |
| 16–20 dusk | 118 (olive-pine) | 72 (red-gold) | warmest hour |
| 20–05 night | 172 (pine→mithril) | 80, ornament shifts to 195 | quiet, silver |

Transitions between phases are interpolated continuously, ~0.6° of hue per minute at the fastest — below the just-noticeable threshold in a single sitting, unmistakable across a day.

### Surfaces

| Token | Noon hex | OKLCH authored | Rationale |
|---|---|---|---|
| `--surface-canvas` | `#101a15` | `oklch(16% .028 var(--hour-hue))` | leaf-shadow, not black — matches the Press in *value* so the family reads coherent, shifts only in hue |
| `--surface-sunken` | `#0b120e` | `oklch(12% .024 var(--hour-hue))` | wells, scroll gutters, inset fields |
| `--surface-1` | `#16221c` | `oklch(19% .032 var(--hour-hue))` | first lift; row hover ground on lists |
| `--surface-2` | `#1c2a23` | `oklch(23% .036 var(--hour-hue))` | panes, sheets, cards-that-aren't-cards |
| `--surface-3` | `#23332b` | `oklch(27% .040 var(--hour-hue))` | popovers, menus — the top of a deliberately shallow stack |
| `--surface-hover` | `#1f2e26` | `oklch(25% .038 var(--hour-hue))` | one clear step, no glow |
| `--surface-active` | `#2a3b31` | `oklch(30% .044 var(--hour-hue))` | pressed reads *lighter* (glass, not stone) |

Chroma rises slowly as lightness rises (.024→.044) — the inverse of the amateur move; high chroma at low L is exactly what makes dark greens go murk.

### Inks

| Token | Hex | Contrast on `--surface-canvas` | Rationale |
|---|---|---|---|
| `--ink` | `#ece4cf` | **14.1 : 1** | warm parchment, gold-leaning; never pure white — white on green reads clinical |
| `--ink-muted` | `#a8b3a2` | **8.2 : 1** | sage grey, still comfortably AA at small sizes |
| `--ink-faint` | `#798a7e` | **4.9 : 1** | deliberately kept above 4.5 rather than the usual 3:1 decorative floor |
| `--ink-machine` | `#9fb4b0` | **8.2 : 1** | cooler, silver-green — the Machine Hand's mithril voice, unmistakably not human ink |
| `--rail-machine` | `color-mix(in srgb, var(--ink-machine) 34%, transparent)` | — | unchanged mechanism from the house Machine Hand |
| `--ink-on-accent` | `#101a15` | 7.6 : 1 on `--accent` | dark leaf ink on brass; never white-on-gold |

### Edges

| Token | Hex | Rationale |
|---|---|---|
| `--edge-subtle` | `#23312a` | list rules; barely there, the Editorial row's whole separation budget |
| `--edge` | `#33443a` | default hairline; ~1.6:1 against canvas — a rule, not a wall |
| `--edge-strong` | `#4d6155` | field borders, focused containers |

### Accent, ring, status

| Token | Hex | Rationale |
|---|---|---|
| `--accent` | `#c8a558` | antique brass. **7.6 : 1** on canvas — passes AA for body-size text, not just large |
| `--accent-hover` | `#dbb96e` | one step toward the highlight, no glow |
| `--accent-active` | `#ab8940` | pressed brass darkens |
| `--accent-muted` | `color-mix(in oklch, var(--accent) 16%, transparent)` | selected-row wash; stays a wash, never a fill |
| `--ring` | `#f0d896` | independent, brighter than accent so focus never hides inside an accented element; ≈13:1 canvas, ≈9:1 on `--surface-3` |
| `--success` | `#86c08a` | **8.4:1** — desaturated leaf, must not be confusable with the green *ground*, so it is pushed lighter, not more saturated |
| `--warning` | `#e0a03a` | **7.8:1** — amber pushed orange to separate from `--accent` brass |
| `--danger` | `#e0857a` | **6.6:1** — the Namárië rubric red, muted to rose-rust; a manuscript correction mark, not a fire alarm |
| `--info` | `#8fb8c6` | **8.3:1** — mithril blue-silver, the same family as the machine ink |

### Shadows (forest floor, not office drop-shadow)

```
--shadow-1: 0 1px 2px rgba(4,10,7,.40);
--shadow-2: 0 2px 6px rgba(4,10,7,.46);
--shadow-3: 0 6px 16px rgba(4,10,7,.52);
--shadow-4: 0 12px 32px rgba(4,10,7,.58);
--shadow-5: 0 24px 64px rgba(4,10,7,.64);
```
Near-black-green with a green cast, higher alpha and softer radius than the Study's — under a glass roof, shade is deep and edges are soft.

### Room knobs

| Token | Value | Rationale |
|---|---|---|
| `--stroke-hairline` | `1.25px` | between the Press's 1.5px and the Study's 1px: parchment ink on green halates less than white on black, so the rule can be finer than the Press's without vanishing |
| `--body-font-size` | `var(--text-md)` | dark ground ⇒ the Press's optical upsize applies here too |
| `--tracking-body` | `0.006em` | slightly less than the Press's 0.008em; the lower ink/ground contrast already opens the line |
| `--canvas-grain-opacity` | `0.030` | glass, dust, and leaf-shadow — present, never legible as a pattern |
| `--canvas-grain-image` | dual-layer SVG data URI: `feTurbulence baseFrequency=.85 numOctaves=4` **plus** one stroke-only tileable leaf-vein path at `stroke-opacity=.5`, 180×180 tile | turbulence carries the Press's letterpress kinship; the vein layer is the only literal botany allowed on a full-bleed surface, and only because at 3% it registers as texture, never as wallpaper |

---

## 3. Typography

- **Body / UI: Inter** — unchanged. Two Rooms established that a room is made of material knobs, not a face swap; six-hour readability is not negotiable for a decorative face. The Conservatory's character is carried by color, hairline, and margin, not by the letterforms of a button label.
- **Long-form reading register: EB Garamond** (already self-hosted, zero new asset) — the reader body, note pages, and dossier prose. This is the deliberate execution of the house's own stated appetite ("Oracle typography escapes the Oracle"): in this room, and only this room, the reading surface uses the manuscript face at `--text-md`, 1.62 leading, `tracking-body: 0`.
- **Display: Cormorant** (OFL, self-host woff2 from the upstream TTF) — pane titles ≥ 24px, section openers, drop caps, empty-state lines. Never below 20px; its hairline serifs disintegrate. Pairs by ancestry with EB Garamond.
- **Machine voice: JetBrains Mono, untouched**, for code and machine data. Machine *prose* stays in the house Machine Hand — but recolored to `--ink-machine` mithril-green, and its attribution rail becomes a 1.25px `--rail-machine` line that terminates in a single baked Tengwar tehta rather than a plain stop. The register is preserved; only its ink and its full-stop are of this room.
- **Small-caps labels: EB Garamond SC** if the file exists, otherwise Inter at `--tracking-wide` — never a fantasy face at label size.
- **Drop caps**: `.dropCap` on the first paragraph of a reader chapter and of a long note. Cormorant, `float: left`, 3 lines, `line-height: .82`, gold applied via `background: var(--gold-metal); background-clip: text; -webkit-text-fill-color: transparent`. Optional upgrade: COLRv1 **Bradley Initials** with `@font-palette-values` remapping its palette slots to `--accent` / `--accent-hover`; browsers without COLRv1 fall back to the default palette. One per page maximum, and never in a list.

---

## 4. Tengwar strategy

**Font:** *Tengwar Telcontar* (Free Tengwar Font Project) as the working face — upright, geometric, built for small screen sizes — self-hosted woff2, `--font-tengwar`. *Tengwar Annatar* as a single display face for the one hero moment (the Settings plaque). Both converted locally to woff2; no CDN.

**Where it appears — the complete list, nothing else:**
1. **Rule terminals.** Section-opener rules and the Machine Hand's attribution rail end in one baked tengwa/tehta glyph instead of a blunt stop. Pure punctuation; no word is implied.
2. **Border texture.** A repeating horizontal band of cropped, rotated tengwar strokes at 6% opacity used as a `background-image` on Rank I ornament surfaces, masked to fade out at both ends (`mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)`) so it is visibly an open band, not a frame, and unmistakably not a sentence.
3. **Empty states.** One correct, hand-verified inscription per empty state (six total), baked to SVG paths.
4. **The Settings plaque.** The room's name, in Annatar, at display size, with a Latin caption underneath.
5. **The colophon.** The machine signs generated artifacts with a fixed, pre-transcribed model signature.
6. **Decorative numerals.** Duodecimal tengwar numerals ghosted behind arabic counts (see wildcard 3) — never the count itself.
7. **Watermark.** A single tengwa at 2.5% opacity in the reader's outer margin at chapter openers.

**How correct transcriptions are produced.** Every inscription is transcribed once, at design time, with **Glaemscribe** (Sindarin *mode of Beleriand* for the Sindarin strings, Quenya mode for Quenya), cross-checked against **Tecendil**, hand-verified against the tehtar placement rule (Quenya: mark over the *preceding* consonant; Sindarin Beleriand: over the *following* one; the two are never mixed within one inscription). It is then **converted to outline SVG paths and checked in as static path data** — not as live font text. Consequence: the correctness is frozen at review time and cannot drift with a font update, a locale, or a copy edit. The live Tengwar font is used **only** for the abstract border texture in (2), where nothing is meant to be read.

**The hard rule.** *Tengwar never renders a string that the application computed.* No user content, no resource title, no count, no date, no model output, no translated label, ever. There is a frozen `TENGWAR_INSCRIPTIONS` record of roughly a dozen entries and if a string is not in that record it does not get elvish script. A lint rule asserts the Tengwar font-family appears in exactly two CSS locations. This is the single rule that separates homage from the wrong-tattoo failure, and it is worth an explicit gate.

---

## 5. Ornament system

**The grammar: one motif, three moves.** A single-stroke open vine — asymmetric, branching outward, terminating off-edge, never closing on itself. Three moves only: the **terminal** (a rule that ends in a leaf), the **corner spur** (one branch entering from a corner and leaving the frame), and the **band** (the tengwar texture strip). No closed interlace, no knot, no laurel wreath, no full frame, ever.

**Techniques, per element:**
- **Corner spurs** — four absolutely-positioned `<span aria-hidden>` elements with an inline SVG `background-image`, mirrored by `transform: scaleX(-1)` / `scaleY(-1)` so one asset serves four corners. Chosen over `border-image` deliberately: `border-image-repeat` edge behavior differs across engines and `mask-border` is absent in Firefox.
- **Vine dividers** — `mask-image` with a seamless 240×24 path repeated `repeat-x`; the path's first and last points share a y-value with horizontal-tangent bezier handles so the tile has no visible kink.
- **Gold rings** (avatar frames, the appearance-picker's selected state) — transparent border with the double-background trick: `linear-gradient(var(--surface-2),var(--surface-2)) padding-box, conic-gradient(from 45deg, #6b4a20, #f0be79, #fff3d0, #c99a4a, #6b4a20) border-box`.
- **Metal gold** — a token triple `--gold-a #8f6a2c` / `--gold-b #c8a558` / `--gold-hi #f6e6bd` composed at point of use into a 7-stop 135° gradient. Real metal is multiple values of one hue; flat `#ffd700` is why cheap gold looks cheap.
- **Grain** — the dual-layer data URI already in the token block, via the existing `body::before`.

**Restraint hierarchy.** A single multiplier token `--ornament: 1 | .5 | 0` gates everything; ornament pseudo-elements read it and collapse to `content: none` at 0.

- **Rank I — full ornament (exactly three surfaces).** Settings→Appearance (the plaque, the ring, the band), empty states, and the About/colophon page. These are rooms you visit rarely and where decoration *is* the content.
- **Rank II — a whisper (`--ornament: .5`).** Pane header rule (terminal leaf only), switchboard section openers, reader chapter dividers, dialog/sheet top corners (one spur, leading corner only — not four), scrollbar thumb, focus ring. One move each, never two.
- **Rank III — bare (`--ornament: 0`), enforced.** Editorial ResourceRow lists, chat prose, reader body text, tables, forms, the player transport, anything inside a virtualized list. The house law that lists read as editorial rhythm rather than a pile of tiles is stronger than this theme.

**Graceful degradation.** `--ornament` drops to 0 automatically under any of: `@container (max-width: 480px)`; a list with more than ~12 visible rows; `print`; `forced-colors: active`; and inside any element carrying the virtualization attribute. Ornament is authored so that removing it changes nothing structural — every spur and terminal is a pseudo-element on an already-complete layout. The Conservatory with all ornament stripped is still a beautiful green room, and that is the test.

---

## 6. Light & motion

**Ithildin, correctly.** The mithril reveal is the room's signature and is used on **two** element types only: the pane-header rule terminal, and the reader chapter divider. At rest the ornament is drawn at `oklch(78% .012 195 / .18)` — perceptually a smudge. On `:hover` / `:focus-visible` it fades to full and gains a two-layer glow via `filter: drop-shadow(0 0 5px oklch(86% .05 195 / .85)) drop-shadow(0 0 14px oklch(86% .05 195 / .45))` — `drop-shadow`, not `box-shadow`, so the bloom follows the glyph's alpha rather than its box. Timing `var(--duration-slow)` in, `var(--duration-fast)` out with `var(--ease-out)`: moonlight arrives slowly and leaves at once. **At night (`--hour-gold` in its night phase) the resting opacity rises to .30** — the inscription is genuinely easier to see after dark, which is the whole joke, and it is real.

**Everything else is ordinary and fast.** Hover: one surface step, `--duration-fast`. Active: `--surface-active`, no transform, no scale. Focus: `--ring` at 2px with 2px offset and `border-radius: var(--radius-sm)` — every focus ring in this room is curved; a square focus ring is the one geometry the Conservatory does not contain. Selected rows: `--accent-muted` wash plus a 2px leading brass edge.

**The lamp.** A single `position: fixed` pseudo-element carries a soft radial gradient at 6% `--accent` and is `transform: translate3d()`-ed to follow the caret / active selection / scroll anchor, `--duration-slow`, `--ease-out`. It is one compositor-layer transform, never a `filter`, never a `backdrop-filter`, and it is the only continuously-moving thing in the theme.

**`prefers-reduced-motion: reduce`** — the house already zeroes durations. On top of that: the Ithildin reveal keeps its *end state* and loses its transition (focus snaps straight to glowing — the meaning survives, the animation does not); the lamp stops following and parks at the viewport centre at 3% opacity; the hour drift updates only on page load rather than on a timer; no shimmer sweep exists anywhere in the theme in any motion mode.

---

## 7. Signature moments

1. **Pane header (`PaneHeaderIdentity`).** The two-line identity block sits above a 1.25px `--edge` rule that terminates, at the right margin, in one Ithildin tengwa. It is invisible until your pointer enters the header, then it lights silver. Every pane in the app has a quiet star in its corner and you find out about it by accident, once.
2. **Editorial ResourceRow.** Zero ornament, by law. Instead: on hover, a 2px brass edge grows from the row's leading edge — `transform: scaleY(0→1)`, `transform-origin: center`, `--duration-fast`. The row does not lift, tint, or round. The most-used surface in the app is the most restrained one; that asymmetry is what makes the ornamented surfaces land.
3. **The switchboard.** Section openers are Cormorant small-caps at `--text-sm` with a vine-masked rule running to the right margin and fading out. The search field's underline is a single hairline that, on focus, does not change color but *lengthens* past the field's edge by 12px — the room reaching for you.
4. **Reader chapter opener.** A gold-gradient Cormorant drop cap, a 2.5%-opacity tengwa watermark in the outer margin, and a vine divider above the chapter title. Three ornaments on one page and then nothing at all for eleven thousand words. This is the entire thesis of the theme in one screen.
5. **Scrollbar.** Thumb is a brass gradient with a 2px `--surface-canvas` border so it reads as inset in a channel rather than pasted on the page; track is `--surface-sunken`. `scrollbar-color` for the standard path, `::-webkit-scrollbar-*` for the rest.
6. **Selection.** `::selection` becomes `color-mix(in oklch, var(--accent) 32%, transparent)` with `--ink` retained — and this is where the two hardcoded pairs inside `MachineText.tsx` finally get tokenized, so the machine's own prose highlights in mithril rather than in an orphaned hex.
7. **Empty states.** The highest-ornament surface in the running app: a Cormorant line, a correct baked Tengwar inscription beneath it at `--ink-faint`, and a single asymmetric vine growing off the left edge of the frame. Empty states are the only place in the product where decoration *is* the payload.
8. **Focus ring.** `--ring` pale gold, 2px, 2px offset, `--radius-sm`. Independent of `--accent` so a focused brass button still shows its ring. It is the one token that must never drift with the hour, and it does not.
9. **Toasts.** No card. A `--surface-2` slab with a single 2px brass leading edge and one vine spur at the leading corner, `--shadow-3`. Status toasts swap the edge to `--success` / `--warning` / `--danger`; the spur stays brass, so the ornament never encodes meaning that color already carries.
10. **The Settings appearance picker.** Three tiles: the Press, the Study, the Conservatory. The Conservatory tile is the only one with a conic-gradient gold ring, the Tengwar plaque in Annatar, and — if it is currently selected — a live 1px band that visibly shifts hue across the day. Choosing a theme should feel like choosing a room, and this is the one place where showing off is the correct behavior.

---

## 8. What we refuse

1. **No closed interlace.** No Celtic/Norse knotwork, no woven border, no symmetric medallion. Closed interlace reads Dwarvish and generic-fantasy; elvish is open, asymmetric, and branching. Every ornament in this theme exits the frame.
2. **No Christmas, no casino.** Hue-wheel green plus `#ffd700` is the failure. Both hues are aged: green desaturated toward moss/pine (chroma ≤ .044), gold toward brass (`#c8a558`, a cousin of the existing `#c4a472`). The gap should read as brass on old moss.
3. **No Skyrim mod.** No embossed bevels, no hammered-metal skeuomorphism, no carved-stone insets, no scroll-shaped or banner-shaped buttons. Flat confident color, one gradient reserved for actual metal.
4. **No sparkle.** No particle effects, no looping shimmer sweep, no glowing text-shadow on headings. Exactly one glow effect exists (Ithildin), it is opt-in via attention, and it appears on two element types.
5. **No parchment everywhere.** One 3%-opacity grain on the canvas and nowhere else. No textured panel backgrounds.
6. **No fantasy serif at body size.** Cormorant never renders below 20px; Tengwar never renders as readable text at all.
7. **No fake Tengwar and no naive transliteration.** Either a Glaemscribe-verified baked inscription or abstract cropped-glyph texture. Nothing in between.
8. **No ornament on every panel.** Three surfaces get full ornament. The restraint is the premium signal; every reference agrees, and the house's own Editorial row already proved it.
9. **No drift that changes contrast.** Lightness and chroma are locked per token; only hue interpolates. A living theme that gets harder to read at 4pm is a broken theme.
10. **Eight-pointed stars are out; six is in.** If a mark is ever needed, it is Eärendil's six-pointed wayfinding star, not Fëanor's eight-pointed craftsman's device. This app is navigation, not a forge.

---

## 9. Readability & accessibility commitments

- **Body ink ≥ 12:1** on `--surface-canvas` and ≥ 10:1 on every surface up to `--surface-3`. Measured: 14.1:1 and 10.5:1.
- **Every ink token clears AA, including the faint one** — `--ink-faint` is tuned to 4.9:1 rather than parked at the 3:1 decorative floor.
- **Every status color and the accent clear AA at body size** (6.6–8.4:1), so status can be carried by color *and* text without a size caveat.
- **The focus ring is independent, drift-locked, and ≥ 3:1 against every adjacent surface**, including against `--accent` itself.
- **Contrast is invariant under the hour drift, by construction** — L and C are literals; only H is a variable. This is checkable by a unit test that asserts no `oklch()` in the block places `var(--hour-*)` anywhere but the third slot.
- **The theme must be added to the existing per-theme WCAG browser test** (`EntrySurfaces.browser.test.tsx`'s `it.each(["dark","light"])` array) — an unaudited third theme is worse than no third theme.
- **Ornament is never load-bearing.** No meaning is carried by a vine, a glyph, a glow, or a leaf that is not also carried by text or by an already-accessible color. Strip every pseudo-element and the app is unchanged in function.
- **`forced-colors: active`, `print`, and reduced-motion each degrade to a plain, complete, readable room.**
- **No `backdrop-filter` anywhere except a single modal scrim**, and no `filter` animated per-frame on a scrolling surface.
- **The reader is exempt from theming decoration entirely.** No ornament, no grain, no lamp inside the text column. The artifact stays sovereign.

---

## 10. Three OOD wildcards

**Wildcard 1 — Sigil-vines: every book grows its own branch, and reading it puts leaves on it.**
Each resource gets a deterministic ornament generated from a hash of its id: a 4-iteration L-system with three production rules picking branch angle, curl direction, and node count from the hash bits. The result is a unique open vine — stable forever, identical on every device, costing no design time and no storage — rendered once as an inline SVG path in the resource's pane header margin. Then the strange part: **leaf density is your reading progress.** An untouched resource is a bare branch. Halfway through, half the nodes carry leaves. Finished, it is in full leaf. A book you have not opened in a year begins to shed. Progress becomes botany instead of a bar, your library becomes a visibly seasonal thing, and no two items in it have ever looked alike. Cost: one hash, one path, one CSS custom property (`--leafing: 0..1`) driving `stroke-dasharray` on the leaf group.

**Wildcard 2 — Light as a material that pools around attention.**
The lamp described in §6, taken seriously: the Conservatory has one light source and it follows your reading. The pooled region is not just brighter — inside it, `--ink-faint` interpolates one step toward `--ink-muted` via `color-mix`, so *peripheral text becomes more legible as your attention approaches it*, and recedes as you leave. Marginalia, timestamps, and machine attribution are legible where you are looking and quiet everywhere else. The inverse also holds: surfaces untouched for months take a −0.004 chroma shift, the dusty-glass state, so a neglected corner of the library is visibly dustier than a live one. One compositor transform, one `color-mix`, zero new components.

**Wildcard 3 — The room learns your hours, and counts in twelves.**
Two joined strangenesses. First: the drift curve is not bound to clock noon but to **your** noon. The theme records, locally, the hours at which you actually read; over a few weeks the phase curve shifts so that the room's leaf-green midday lands in the middle of *your* reading day and its mithril night arrives when you are actually up late. A person who reads from 10pm to 3am gets a Conservatory whose noon is at midnight. The room is not simulating the sky; it is learning a circadian schedule and rendering it. Second, and stranger: Tengwar numerals are **duodecimal and written least-significant-digit first**. Wherever the app shows a decorative, non-load-bearing count — items in a collection, highlights on a page — the arabic number is joined by a ghosted base-12 tengwar numeral at 8% opacity behind it. It is not a translation and it is not a substitute; it is the room quietly insisting that there are other ways to count, in a hand you cannot read, in a base you do not use, at an hour it decided was noon.

# The Solar — final direction for the third room

*Machine value: `data-theme="elvish"`. Display name: **the Solar**. Research and design only; no product code changed by this document.*

**Spine:** the LOTHLÓRIEN concept (*the Flet*) — its green-twilight pole, its two-light-sources doctrine, its Ithildin-on-attention reveal, its zero-font-bytes Tengwar policy, its ornament dimmer.
**Grafted from RIVENDELL:** the name and the three-rooms-of-one-house story; the contrast-audit discipline and the faint-ink ban; the instant-exit motion law; the Eärendil six-pointed mark; the brass-rod scrollbar; the **Living Marginalia** wildcard.
**Grafted from VISIONARY (*the Conservatory*):** the "lightness and chroma are literals, hue is the only variable" proof technique — narrowed to the one element that legitimately responds to time; the `--ornament` multiplier as the single degradation lever; the lint gate that pins where an elvish face may appear; the glass-roof half of the room's story.

---

## 1. Name & story

**The Press. The Study. The Solar.**

A *solar* is the real architectural name for the withdrawing room built above a great hall — the private upper chamber, glazed on the west side, where the household read and wrote and kept its books while the hall below stayed loud. It is the one room in the building designed around late light. Three rooms of one house, ascending: **the Press** is the night workshop below (near-black, grained, reversed type, gold struck on lead); **the Study** is the day desk on the main floor (paper, daylight, ruled hairlines); **the Solar** is the room at the top of the stair.

> You go up because the reading is better up here. The sun has gone behind the valley wall, the west glazing is full of the canopy, and the green light coming through the leaves is the only light in the room except one brass lamp and, later, the stars. Nothing is dramatic. Everything is old, made by hand, and unhurried. This is the room you climb to when you want to be alone with a long text and not be reachable.

Three names of ordinary English, three working rooms, three hours: **the Study is noon, the Press is midnight, the Solar is the long green dusk.**

The elvish register is not a costume over this; it is the room's logic. Things that grow are open, asymmetric and branching, never knotted or closed. Metal is aged, never new. There are exactly two lights — the lamp and the moon — and they never trade jobs. And the writing on the walls is in a hand you are not asked to read, only to feel the discipline of.

**Settings copy:** *"The Solar — the room at the top of the stair; green dusk, one brass lamp, and a book left open."*

*(Name from Rivendell; the high-room-in-the-leaves imagery from the Flet; the glass-and-green half of the story from the Conservatory. "The Flet" is the same idea in diction only a Tolkien reader can parse — a room named for the floor of a talan. "The Conservatory" is four syllables of Victorian greenhouse. "The Solar" is the legible one, it names an hour rather than a colour, and it puts all three rooms in one building.)*

---

## 2. Base pole — the decision

**Twilight green. A third pole, not a variant of either existing room.** All three concepts independently reached "twilight," and they are right: the Study is paper and the Press is ink, and a third room that is merely "dark with a green tint" is a skin, not a room. The Solar's canvas sits at `#15201b` — measurably lighter than the Press's `#0e0e10` (relative luminance ≈0.0135 vs ≈0.0055, roughly 2.5× the light) and carrying chroma where both other rooms carry literally none. It reads as *air with light inside it* rather than as ink.

The genuine disagreement was the **hue** of that twilight, and it decides the whole theme. Rivendell proposed an olive-walnut ground (hue ≈100°, `#1c2016`) — carved oak gone almost black. It is beautiful and it is wrong here, for one reason: the Press is *already* aged gold (`#c4a472`) on a warm near-black, so a warm brown-olive room reads as **the Press with the lights turned up**, and the third room's whole job is to be a third thing. The Flet's and the Conservatory's green-grey (hue ≈150–160°) is further from the Press in hue than anything else in the safe range, it is what "elvish" actually means to the eye, and it makes the brass accent *warm* by contrast instead of merely present. So: **green-grey ground, brass lamp, silver moon.** The chroma ladder rises with lightness (0.014 → 0.024 OKLCH) rather than falling — pushing chroma up at low lightness is exactly what turns dark greens to murk, and it is the single most common way this palette fails.

---

## 3. Complete token block

Every value below is measured, not asserted; the contrast table in §9 is computed from these exact hexes. `color-scheme: dark` so native form controls, date pickers, autofill and UA scrollbar arrows render dark and do not punch white holes in the room.

```css
[data-theme="elvish"] {
  color-scheme: dark;

  /* --- Surfaces: the mallorn ladder. Green-grey, chroma rising with lightness. --- */
  --surface-sunken: #0f1714;  /* the gap between planks — wells, inset fields, tracks */
  --surface-canvas: #15201b;  /* dusk under the canopy; deliberately NOT black */
  --surface-1:      #1a2620;  /* first lift — rows, reader chrome, scrubbed planking */
  --surface-2:      #1f2d26;  /* panes, sheets, code blocks */
  --surface-3:      #26352d;  /* dialogs, menus, popovers — top of a shallow stack */
  --surface-hover:  #2a3a31;  /* one step up AND one hue-degree toward gold: lamplight */
  --surface-active: #32463b;  /* pressed reads lighter — glass, not stone */

  /* --- Inks: mallorn leaf in autumn, on green dusk --- */
  --ink:         #ece5d1;  /* warm pale gold-cream, never white; 13.3:1 on canvas */
  --ink-muted:   #adb8a8;  /* silver-sage, the underside of the leaf; 8.1:1 */
  --ink-faint:   #8fa295;  /* metadata, timestamps, disabled; 6.2:1 — still AA everywhere */
  --ink-machine: #a3b9bd;  /* Galadriel's glass: cool water-silver, 8.2:1 */
  --rail-machine: color-mix(in srgb, var(--ink-machine) 34%, transparent);
  --ink-on-accent: #131c17; /* near-black green on brass fills; 7.7:1 on --accent */

  /* --- Edges: rules, not walls --- */
  --edge-subtle: #243128;  /* row separators — rhythm, not lines */
  --edge:        #33443b;  /* the default hairline */
  --edge-strong: #647c6e;  /* 3.7:1 on canvas, 3.2:1 on --surface-2 */

  /* --- Accent: the lamp. Mallorn-gold, aged to brass. --- */
  --accent:        #c9a95f;  /* 7.4:1 on canvas — legal as body-size link text */
  --accent-hover:  #ddbe79;  /* the lamp turned up */
  --accent-active: #ab8b45;  /* pressed brass, darker and duller */
  --accent-muted:  color-mix(in srgb, var(--accent) 16%, transparent);

  /* --- Ring: the moon. Attention is starlight, never firelight. --- */
  --ring: #cfe6e0;  /* 12.8:1 on canvas, 9.9:1 on --surface-3 */

  /* --- Status: separated from a green field by lightness AND chroma --- */
  --success: #8ed3a4;  /* niphredil — pushed lighter, not more saturated; 9.6:1 */
  --warning: #e2a352;  /* lamp-amber, pushed orange so it can never be read as --accent; 7.6:1 */
  --danger:  #e8867a;  /* rowan berry, coral not fire-engine — never a Christmas pair; 6.5:1 */
  --info:    #99c4d6;  /* moon on Nimrodel; same cool family as --ink-machine; 8.9:1 */

  /* --- Shadows: green-black and diffuse. Light through leaves has no hard edge. --- */
  --shadow-1: 0 1px 2px rgba(3, 10, 8, 0.36);
  --shadow-2: 0 2px 6px rgba(3, 10, 8, 0.42), inset 0 1px 0 rgba(244, 224, 176, 0.05);
  --shadow-3: 0 6px 16px rgba(3, 10, 8, 0.48), inset 0 1px 0 rgba(244, 224, 176, 0.06);
  --shadow-4: 0 14px 34px rgba(3, 10, 8, 0.54), inset 0 1px 0 rgba(244, 224, 176, 0.07);
  --shadow-5: 0 28px 64px rgba(3, 10, 8, 0.60), inset 0 1px 0 rgba(244, 224, 176, 0.08),
              0 0 40px rgba(201, 169, 95, 0.05);

  /* --- Per-room knobs (the Two Rooms mechanism, unchanged) --- */
  --stroke-hairline: 1.25px;         /* between Study 1px and Press 1.5px: this canvas
                                        halates less than #0e0e10, more than paper */
  --body-font-size: var(--text-md);  /* 1rem — reversed type needs the optical size-up */
  --tracking-body: 0.006em;          /* under the Press's 0.008em; lighter ground, less bloom */
  --canvas-grain-opacity: 0.05;      /* structured grain needs more than noise to register */
  --canvas-grain-image: /* see §3.1 */;

  /* --- Namespaced ornament tokens (same pattern as [data-theme="oracle"]) --- */
  --gilt-a:  #6b4a20;   /* metal's shadow */
  --gilt-b:  #c99a4a;   /* metal's body */
  --gilt-hi: #f4e0b0;   /* metal's highlight */
  --ithildin: #cfe6e0;  /* = --ring; the moon-metal, named separately for intent */
  --ornament: 1;        /* the global dimmer: 1 | .5 | 0 */
  --moon: 1;            /* 0.15–1.0, the lunar-phase scalar (§6, §10) */
  --elvish-vine:   url("…240×12 seamless single-stroke vine, tangent endpoints…");
  --elvish-corner: url("…48×48 open branch, grows inward and stops…");
  --elvish-leaf:   url("…10×10 leaf terminal…");
  --elvish-rule:   url("…baked Tengwar band, cropped stems and bows…");
}
```

Every one of these is a semantic token or a `--gilt-*`/`--elvish-*` namespaced token declared inside this block, so `apps/web/scripts/check-css-tokens.mjs` resolves the whole theme with **zero raw colour literals outside `globals.css` and zero exemptions**. That is not hygiene theatre: it is the proof that the theme repaints every surface in the app with no missed seams.

### 3.1 The grain — two layers in one asset

The Press's grain is pure `feTurbulence`. The Solar's is that *plus* a sub-pixel star field, in one 320×320 tile (the token holds a single image), delivered through the existing `body::before` mechanism at 5% opacity:

```
<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>
  <filter id='t'><feTurbulence type='fractalNoise' baseFrequency='0.85'
    numOctaves='3' stitchTiles='stitch'/>
    <feColorMatrix values='0 0 0 0 .82  0 0 0 0 .87  0 0 0 0 .79  0 0 0 .55 0'/></filter>
  <rect width='320' height='320' filter='url(%23t)' opacity='.7'/>
  <circle cx='34' cy='61' r='.7' fill='%23dfeee8'/>  <circle cx='187' cy='23' r='.55' fill='%23dfeee8'/>
  <circle cx='268' cy='142' r='.8' fill='%23f2f7ee'/> <circle cx='96' cy='214' r='.6' fill='%23dfeee8'/>
  <circle cx='231' cy='287' r='.5' fill='%23dfeee8'/> <circle cx='12' cy='176' r='.45' fill='%23dfeee8'/>
</svg>
```

(Percent-encoded exactly as the Press's tile is: `<` → `%3C`, `#` → `%23`.) At 5% you never see a star; you see that the dark is not flat. **The grain never animates, for anyone.** Reading surfaces suspend it exactly as the Press's does — long-form text never sits on texture.

*Rejected: Rivendell's vine-tile grain. A literal repeating botanical pattern across the full viewport is wallpaper at any opacity where it is visible at all, and it fights the letterpress kinship the Press established. The vine belongs on edges, not on the wall.*

---

## 4. Typography

**One new face. Everything else in the app is already self-hosted or already correct.**

- **UI / body — Inter, unchanged.** `--font-sans` is not overridden. Every list row, button, label, form field, chat message and dense table stays in the same face at the same metrics as the other two rooms. This is the most important restraint in the whole direction: *a theme that swaps body type is a costume; a theme that swaps light is a room.* All three concepts converged on this independently, which is the strongest signal in the set.
- **Reading serif — EB Garamond, already self-hosted, zero new bytes.** The Solar overrides `--font-serif` (today a generic `ui-serif, Charter, Georgia` stack) to `var(--font-eb-garamond), Charter, Georgia, "Times New Roman", serif`. Every serif surface in the app — reader body, note pages, dossier prose — inherits a real book face for free. This is the house's own stated appetite ("Oracle typography escapes the Oracle") executed at a cost of one line.
- **Display — Cormorant** (SIL OFL). The only new asset: two woff2 files, latin subset, weight 300 and 300 italic, loaded via `next/font/local` exactly like the oracle faces, `preload: false`, ≈40KB total. Exposed as `--font-display`. Applied **only at ≥ `--text-xl` (1.25rem)**: pane titles, section openers, empty-state headlines, drop caps, the settings room names. Cormorant's hairline serifs disintegrate below 20px, which is why the size floor is a rule enforced in review and not a suggestion. At display sizes: `letter-spacing: 0.01em`, `font-variant-numeric: lining tabular-nums`.
- **Machine voice — JetBrains Mono, unchanged geometry.** Only `--ink-machine` moves, to the cool `#a3b9bd`, and `--rail-machine` inherits it. The Machine Hand register gains from this room rather than losing: in a warm-inked space, cool machine ink is *more* legible as a separate voice than it is in the Press.
- **Small-caps labels** — Inter at `--tracking-wide`, or EB Garamond small-caps where the face supplies them. Never a fantasy face at label size.
- **Tengwar — no webfont is shipped.** See §5.
- **Drop caps** — Cormorant 300, `float: left`, 3 lines, `line-height: .82`, gilt via `background: linear-gradient(150deg, var(--gilt-a), var(--gilt-b) 34%, var(--gilt-hi) 50%, var(--gilt-b) 66%, var(--gilt-a)); background-clip: text; -webkit-text-fill-color: transparent;` with a plain `--ink` layer beneath so a failed clip degrades to legible text rather than to nothing. **One per long-reading page, ever; never in a list.**

*Contradiction resolved:* Rivendell proposed a COLRv1 drop-cap face (Bradley Initials) with `@font-palette-values` remapping. It is a lovely trick and it is a whole extra font file for one glyph, in a repo whose font policy is deliberately spartan. The Flet's and the Conservatory's gradient-clipped Cormorant achieves the same gilt with tokens we already have. **Rejected.**

---

## 5. Tengwar strategy

**The hard rule, stated once and enforced by gate:** *No string the application computed is ever rendered in Tengwar, and no Tengwar webfont ships.* Delete every Tengwar pixel in the app and nothing becomes unusable, ambiguous, or less navigable.

**Why no font.** Tengwar fonts are *transliteration* fonts: Latin keystrokes mapped to tengwar by phonetic mode. Binding one to a live DOM text node produces glyph-soup — the single most fan-recognisable failure available — and the CSUR PUA route requires a keyboard map nobody will maintain. Rivendell loaded a font and promised never to bind it; Visionary shipped Telcontar for an abstract texture band. Both are unnecessary risk. **The Flet's answer wins: zero font bytes at runtime.**

**The pipeline (done once, at design time, by hand).**
1. Compose the line in Sindarin, Quenya, or English-in-the-English-mode.
2. Transcribe independently in **Glaemscribe** *and* **Tecendil**.
3. Diff the two outputs. If they disagree, the line is wrong — rewrite it; do not fudge it.
4. Set in **Tengwar Annatar** (display) or **Tengwar Telcontar** (small), *installed on the design machine only*, convert to outlines, hand-kern, export minimal `<path>` data.
5. Check the paths into a frozen `elvishInscriptions.ts`, one entry per inscription, each recording: the surface, the Latin source phrase, the language, the **mode** (Quenya tehtar-over-preceding vs Sindarin mode of Beleriand tehtar-over-following — never mixed within one inscription), the two tool outputs, the transcription date and the reviewer.

Baking to paths means: no font substitution, no PUA fallback boxes, no possibility of a future font update silently changing what the wall says, and the correctness is frozen at review time.

**Where it appears — exactly five places, and nowhere else:**

1. **The band.** Section-divider rules on Tier-2 surfaces carry a horizontal strip of *cropped* tengwar stems and bows used as pure repeating geometry, the way a Greek key is geometry, masked to fade at both ends (`mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)`) so it is visibly an open band and not a sentence. Nothing is meant to be read, so nothing can be misread.
2. **The reader's chapter opener** — one verified inscription in the margin rail, resting at `--edge-subtle`, which is the app's single Ithildin element (§6). Never inside the text column.
3. **Empty states** — one verified line, baked, at `--ink-faint`, with the English sentence set beneath it in Cormorant italic. *The English is the message; the Tengwar is the illumination.*
4. **Rule terminals** — the Machine Hand's attribution rail and section-opener rules end in a single baked tehta instead of a blunt stop. Pure punctuation; no word is implied. *(Adopted from the Conservatory.)*
5. **The colophon / About surface** — the one indulgence: the full inscription at legible size, brass on green, with its transcription, mode and translation printed underneath in plain text. If we are going to do it, we show our work.

**Where it never appears:** numerals of any kind, buttons, labels, tabs, menu items, tooltips, toasts, errors, search results, filenames, counts, durations, timestamps, or any string a user must parse or act on. Numerals stay Arabic and tabular, always, with no exception for whimsy — Tengwar numerals are stemless consonants and using them for page numbers is precisely the fan-embarrassing move.

**The gate:** a lint assertion that no `@font-face` or `font-family` referencing a Tengwar face exists anywhere in the app, and that every consumer of `elvishInscriptions.ts` renders it as `aria-hidden` SVG path data. *(Gate mechanism adopted from the Conservatory, inverted to enforce absence.)*

---

## 6. Ornament system

**One motif, recombined: a single-stroke open branch** — asymmetric, growing out of an edge or corner toward the margin, three leaves maximum, terminating off-frame. Never closing on itself. Three cuts of one asset: a **240×12 seamless vine tile** (first and last path points share a y-value with horizontal-tangent handles, so the repeat has no kink — verify the seam at three zoom levels before shipping), a **48×48 corner branch**, and a **10×10 leaf terminal**.

**Techniques, per element:**

- **Vine rules / dividers** — `mask-image: var(--elvish-vine); mask-repeat: repeat-x; mask-size: 240px 12px;` over `background: linear-gradient(90deg, transparent, var(--edge-strong) 12%, var(--edge-strong) 88%, transparent)`. Masking a gradient rather than tiling a coloured image means the rule fades at both ends and recolours from tokens for free.
- **Corner branches** — four absolutely-positioned 48px `<span aria-hidden>` elements with `background-image: var(--elvish-corner)`, opposite corners mirrored by `transform: scaleX(-1)` / `scaleY(-1)`. One authored asset, four placements. **Deliberately not `border-image`:** `border-image-repeat: round` renders inconsistently across engines and `mask-border` is unimplemented in Firefox. All three concepts reached this independently; it is settled.
- **Leaf terminal** — a 10px `::before` on a row's leading edge, `background: var(--accent); mask: var(--elvish-leaf);`, `opacity: 0` at rest.
- **Gold that reads as metal** — never a flat fill. The transparent-border double-background: `border: 2px solid transparent; background: linear-gradient(var(--surface-1),var(--surface-1)) padding-box, conic-gradient(from 210deg, var(--gilt-a), var(--gilt-b), var(--gilt-hi), var(--gilt-b), var(--gilt-a)) border-box;`. Conic, because real metal shows a light source sweeping around a form; flat gold always reads as paint. `background-clip: text` only at ≥ `--text-2xl`, never on content that must be read.
- **Grain** — §3.1, through the existing `body::before`.

**The restraint hierarchy — one number, `--ornament`.** Every ornament pseudo-element multiplies its opacity by it; a container sets it to `0` and the whole system goes silent for that region without deleting a single node.

| Tier | Value | Where | Treatment |
|---|---|---|---|
| **Illuminated** | `1` | Empty states, reader chapter opener, Settings→Appearance, About/colophon. **Fewer than eight surfaces in the entire app; max three ornaments per screen.** | Corner branches, baked inscription, drop cap, gilt ring. |
| **Whisper** | `.5` | Pane header rule, switchboard section openers, sheet top edge, player progress, scrollbar, focus ring. | One mark, one edge. Nothing that costs a repaint. |
| **Bare** | `0` | Every list-row body, table, form field, chat prose, reader body text, dense grid, virtualized list, mobile compact pane, the player transport. | Colour and hairline only. |

**Automatic degradation** — `--ornament` drops to `0` under any of: a list with more than ~12 visible rows; any element carrying the virtualization attribute; `@container (max-width: 480px)` (Tier 1 → Tier 2, leading corner only); `print`; `forced-colors: active`; `prefers-contrast: more` (which also zeroes `--canvas-grain-opacity`). Ornament is authored so that removing it changes nothing structural — every branch and terminal is a pseudo-element on an already-complete layout.

**The test:** *the Solar with all ornament stripped is still a beautiful green room.* If that is not true, the palette is doing too little and the vines are doing too much.

---

## 7. Light & motion

**The governing idea: attention is light, and there are exactly two lights.** The **lamp** (warm, `--accent`) means *interaction*. The **moon** (cool, `--ring` / `--ithildin`) means *attention*. They never trade jobs. Because one is warm and one is cool and they differ by 4–5 steps of lightness, hover and focus are distinguishable without hue perception at all.

- **Hover — the lamp.** `--surface-hover`, plus a directional glow anchored at the element's leading edge: `radial-gradient(120px 40px at 12px 50%, color-mix(in srgb, var(--accent) 9%, transparent), transparent)`. The light has a *source and a direction* rather than uniformly brightening a box. The leaf terminal fades 0 → 0.9. `--duration-fast`, `--ease-glide`.
- **Focus — the moon.** `outline: var(--focus-ring-width) solid var(--ring); outline-offset: var(--focus-ring-offset);` plus one inner hairline of lamplight, `box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent)`. Always `border-radius: var(--radius-sm)` — **a square focus ring is the one geometry this room does not contain.** `--duration-fast` / `--ease-snap`: keyboard focus is instant, always.
- **Active.** `--surface-active`, no scale, no bounce, `--duration-fast`. Pressing is not a trampoline.

**The Ithildin reveal** — the room's signature, used on **two element types only**: the pane-header rule and the reader's chapter-opener inscription. At rest the ornament is drawn in `--edge-subtle` — present in the DOM, perceptually silent. On `:focus-within` of the owning surface (*attention*, not a mouse passing through) it fades to `--ithildin` over `--duration-base` and gains a two-radius bloom:

```css
filter: drop-shadow(0 0 5px color-mix(in srgb, var(--ithildin) 85%, transparent))
        drop-shadow(0 0 14px color-mix(in srgb, var(--ithildin) 45%, transparent));
```

`drop-shadow`, not `box-shadow`, so the bloom follows the glyph's alpha instead of its bounding box; tight core plus wide halo is what makes it read as moonlight rather than as a CSS glow. If paint cost bites, crossfade a pre-blurred duplicate layer instead of animating `filter`.

**Exit is instant.** In 220ms, out in 0–80ms. *(Rivendell's law, adopted verbatim.)* Ornament that lingers on the way out reads as lag, and this repo has been bitten once already by chrome that retreated too slowly.

**The focused pane is the lit one.** The pane with `:focus-within` sits at `--surface-1`; unfocused panes drop a half-step toward `--surface-canvas`. Lamps in the leaves: with nine panes open you can see at a glance which branch you are on, and it costs two background values. This is ornament that answers *"where am I typing?"* — the reason the Ithildin rule earns its place instead of merely decorating.

**`prefers-reduced-motion: reduce`** — the existing block already zeroes every `--duration-*`. On top of that: **every reveal keeps its end state and loses only the interpolation.** The Ithildin still lights, the leaf still appears, the lamp-glow still falls; they arrive instantly. Nothing that carries meaning is motion-only. The grain and star field never animate for anyone, in any mode.

**There is no shimmer sweep, no looping animation, no particle, and no `backdrop-filter` anywhere in this theme except a single modal scrim.** No `filter` is animated on any surface that repaints per scroll frame.

---

## 8. Signature moments

1. **Pane header — the Ithildin rule.** Every pane's identity block sits above a 1.25px vine-masked rule that is essentially invisible. Focus the pane and it silvers and blooms over 220ms, terminating at the right margin in one baked tehta. Nine panes open, one is lit. The single most distinctive thing in the room, and it is also the answer to a real question.
2. **Editorial `ResourceRow` — restraint by law.** Zero ornament, zero cards, no geometry change: a `--stroke-hairline` in `--edge-subtle`, and on hover a leading-edge leaf terminal in brass plus the directional lamp-glow. Selected rows take a 2px brass left rule ending in the leaf, over an `--accent-muted` wash. The most-used surface in the app is the most restrained one — and that asymmetry is exactly what makes the ornamented surfaces land.
3. **The switchboard search field — the room reaches for you.** The underline is one vine stroke at `mask-size: 0% 100%`, showing only a hairline at rest; on focus it *grows outward from the caret* to full width in 200ms via `mask-size` + `mask-position`. Section labels ("Recent", "Commands") are Cormorant small-caps in `--ink-faint` with a vine-masked rule running to the right margin and fading out. The Nexus stops looking like a command palette and starts looking like a table of contents.
4. **Reader chapter opener — the whole thesis in one screen.** A gilt Cormorant drop cap, a verified Tengwar inscription in the margin rail at `--edge-subtle` that lights on focus-within, one vine divider above the title. Three ornaments, and then *nothing at all for eleven thousand words*. The body text is untouched EB Garamond on `--surface-canvas`. Ornament stands at the door and does not come in.
5. **The margin rail — living marginalia.** §10, wildcard 1. The single most beautiful thing in the design.
6. **Scrollbar — the brass rod.** 8px thumb, `--radius-full`, `linear-gradient(90deg, var(--gilt-a), var(--gilt-b) 45%, var(--gilt-a))` with a 2px `--surface-canvas` border so it reads as *inset in the wood*; track `--surface-sunken`. 45% opacity rising to 100% on hover. Set via both `scrollbar-color` and `::-webkit-scrollbar-*` — in 2026 neither alone covers everything. A polished rod on the edge of a shelf, not a grey slug.
7. **Selection — the gilt nib.** `::selection { background: color-mix(in oklch, var(--accent) 28%, transparent); color: var(--ink); }` declared globally in `globals.css` (it does not exist today), and in the same pass the two hardcoded `::selection` pairs inside `MachineText.tsx` get tokenized — a selection that turns brown mid-machine-block is exactly the seam that kills the illusion.
8. **Empty states — the illumination.** The one place where ornament *is* the content: four corner branches, a Cormorant headline, a verified baked Tengwar line beneath it at `--ink-faint`, the English in Cormorant italic, and the **six-pointed Eärendil star** as the mark. Six, not eight: Eärendil is the wayfinder; Fëanor's eight-ray star is a craft guild's badge and the wrong connotation for a knowledge instrument. *(Mark adopted from Rivendell.)* An empty shelf in the Solar should feel like a place, not an error.
9. **Player progress — the lamp moves along the branch.** The elapsed fill is a `--gilt-a` → `--gilt-b` gradient on a `--surface-sunken` track; the leading edge carries a 6px `--ithildin` bloom that travels with it. Nothing else changes.
10. **Toasts — the hearth rim.** `--surface-3`, `--shadow-4`, no card ornament (it is transient), and a 1px brass top rule that draws left-to-right in 180ms as the toast enters. Status toasts swap the *edge* to `--success` / `--warning` / `--danger`; the rule stays brass, so ornament never encodes meaning colour already carries. Every `--shadow-2` and above carries `inset 0 1px 0` of firelight along its top edge — 1px, and it is what makes the whole room feel lit from somewhere.
11. **Settings → Appearance — three doorways.** Not three radio labels: three miniature elevations, each rendering three lines of its own room in its own canvas, ink, accent and hairline weight — the Study, the Press, the Solar. The Solar's carries one lit lamp, a conic gilt ring, and its plaque in Annatar with the Latin caption beneath. Choosing a theme should look like looking through three doorways, and this is the one surface where showing off is the correct behaviour.

---

## 9. Refusals & accessibility commitments

### What we refuse

1. **No closed interlace.** No Celtic knots, no Norse braids, no woven borders, no symmetric medallions, no laurel wreaths. Knotwork reads Dwarvish and generic-fantasy. Every ornament in this room is open, asymmetric, botanical, and exits the frame.
2. **No Christmas.** Never hue-wheel green against `#ffd700`. Every green is desaturated toward moss and pine (chroma ≤ 0.024 on every surface), the gold is aged to brass `#c9a95f`, and the red is pulled to coral `#e8867a`. The pairs never sit adjacent at full strength. The gap should read as brass on old moss.
3. **No casino.** No looping shimmer, no shine sweep, no glitter, no particles, no glow on headings. Exactly one glow effect exists in the theme (Ithildin), it responds to attention, it appears on two element types, and it stops.
4. **No Skyrim mod.** No embossed bevels, no hammered-metal skeuomorphism, no carved-stone insets, no parchment behind every panel, no scroll-shaped or banner-shaped buttons, no ornate 9-patch frames. Flat confident colour; the only "material" in the room is a 5% grain, a 1px rim light, and one conic gradient reserved for actual metal.
5. **No fantasy serif at body size.** Cormorant never renders below 20px. Inter carries every functional string in the app.
6. **No fake runes and no naive transliteration.** Either a double-tool-verified baked inscription or abstract cropped-glyph texture. Nothing in between, and no Tengwar webfont in the bundle.
7. **No Tengwar that means anything.** If it can be deleted without loss, it may stay. If a user needs it to operate the app, it is a bug.
8. **No ornament on content.** No gradient text, tinted panels, vines, glyphs or grain inside reading text, chat answers, or code blocks. Ornament lives on edges and in absences. **The artifact stays sovereign.**
9. **No ornament in dense views.** More than ~12 repeats on screen and `--ornament` goes to 0. Ornament that is everywhere stops being ornament and becomes noise.
10. **No hour-drifting canvas.** See §10 for the arbitration.
11. **No touching identity.** The asterism mark, favicon, apple-icon, OG image and PWA manifest stay brand-dark. Those represent the product; the Solar is a room inside it. Oracle does not touch them either.
12. **No ornament that is the only carrier of meaning.** Every vine, glow and glyph is decoration over a state already legible in colour, position and text.

### Measured contrast (WCAG 2.1, computed from the §3 hexes)

| | sunken | canvas | surface-1 | surface-2 | surface-3 | hover |
|---|---|---|---|---|---|---|
| `--ink` | 14.5 | **13.3** | 12.4 | 11.4 | 10.3 | 9.6 |
| `--ink-muted` | 8.9 | **8.1** | 7.6 | 7.0 | 6.3 | 5.8 |
| `--ink-faint` | 6.7 | **6.2** | 5.8 | 5.3 | 4.8 | 4.5 |
| `--ink-machine` | 8.9 | **8.2** | 7.6 | 7.0 | 6.3 | 5.9 |
| `--accent` (as text) | 8.1 | **7.4** | 7.0 | 6.4 | 5.7 | 5.3 |
| `--ring` | 13.9 | **12.8** | 12.0 | 11.0 | 9.9 | 9.2 |
| `--edge-strong` | 4.0 | **3.7** | 3.5 | 3.2 | 2.9 | 2.7 |
| `--success` / `--warning` / `--danger` / `--info` on canvas | — | **9.6 / 7.6 / 6.5 / 8.9** | | | | |

`--ink-on-accent` on `--accent`: **7.7:1**.

### Commitments

1. **Body ink ≥ 13:1 on canvas and ≥ 10:1 on every surface step.** Muted ink ≥ 6:1 everywhere. **Faint ink ≥ 4.5:1 on every surface it is permitted on** — no metadata in this app ever falls below AA — and faint ink is *banned above `--surface-3`*.
2. **`--accent` is a legal body-size text colour** (7.4:1 on canvas, 5.7:1 on `--surface-3`), so links never need an exception. They keep their underline anyway.
3. **The focus ring is an independent token**, ≥ 9:1 against every surface it can land on and ≥ 3:1 against `--accent` itself, 2px with 2px offset, never suppressed by ornament, never hue-only.
4. **Status is never hue alone.** Every status colour differs from the field and from the others in lightness *and* chroma, and every status surface pairs its colour with a glyph or a word. `--success` is pushed *lighter*, not more saturated, precisely so green-on-green cannot collapse.
5. **Numerals stay Arabic and tabular.** Always.
6. **The reading column is inviolate.** No ornament, tint, texture, grain, lamp or Tengwar inside the text measure.
7. **Reduced motion preserves meaning** by keeping end states, never by removing an affordance.
8. **`forced-colors: active`, `prefers-contrast: more`, and `print` each degrade to a plain, complete, readable room** — all ornament opacity to 0, grain to 0.
9. **`"elvish"` joins the existing per-theme contrast test.** `EntrySurfaces.browser.test.tsx:367` iterates `["dark","light"]`; the Solar goes into that array and clears the same 4.5:1 text / 3:1 non-text assertions, or it does not ship. An unaudited third theme is worse than no third theme.
10. **A `.readerThemeElvish` block, if built, is a separate proof.** The reader themes are documented as independent of the app room; an elvish reader theme must independently clear the same floors and be shown to *compose with*, not fight, `[data-theme="elvish"]` — the same proof Two Rooms had to make.
11. **`color-scheme: dark`**, so native controls, scrollbar arrows and autofill do not punch white through the leaves.
12. **Zero raw colour literals outside `globals.css`; no `check-css-tokens.mjs` exemption.**

---

## 10. Wildcards — adopted, and the one arbitration

### The arbitration: does the room know what time it is?

The Conservatory's crown jewel is an **hour-drifting canvas** — every token authored in `oklch()` with lightness and chroma hard-coded and *only hue* interpolated across the day, so contrast is invariant by construction. The Flet's crown jewel is the exact opposite: **the room outside time**, a place that refuses to tell you the hour, because that is what Lothlórien *is*.

**The Flet wins, and the Conservatory's mechanism is kept.** A canvas that changes hue while you are reading in it for six hours is a room that fidgets, and it costs an SSR clock, a hydration-safe first paint, a 6-minute timer, and a root-variable repaint — the largest feasibility bill in the whole set, paid for an effect the user is explicitly designed not to notice within a sitting. More importantly it contradicts the room's own pitch: the Solar is the place you climb to *in order to be unreachable*, and a room that keeps announcing the hour is reachable.

But the Conservatory's **proof technique** — L and C are literals, hue is the only variable, therefore no time-varying effect can ever break a contrast commitment — is genuinely excellent engineering and is adopted wholesale for the one element that has a canonical right to respond to time: the Ithildin. That is wildcard 2.

### Wildcard 1 — Living marginalia *(from Rivendell, fused with the Flet's wear-marks)*

The reader's margin rail carries **one continuous SVG vine** spanning the document's full height, and it is simultaneously the progress bar, the highlight map, and the page's illumination.

- The stroke is drawn only as far as your **furthest-read position** (`stroke-dasharray` against `pathLength="1"`), so the vine *grows as you read the book*.
- At every **highlight** you have made, a leaf sprouts from the vine at that document offset, tinted by the highlight's ink. Hovering a leaf scrubs to that highlight — it is not decorative-only.
- Your current position is a single brass bud.
- **And the wood remembers where you walk** *(the Flet's third wildcard, grafted in)*: long-dwell reading positions leave a permanent, almost imperceptible mark on the rail behind the vine — a 3px hairline at `--edge` + 6% lightness, accumulated locally, per resource, never synced, never surfaced as a number, never clickable. Re-open a book you have read three times and the rail carries a faint worn path down its length, brighter where you stopped and re-read, blank across the chapters you skimmed.

Three widgets collapsed into one drawing; the drawing is different for every book because you made it; and half of it is authored by the user without their knowing it. It is the groove worn into a wooden step by people going up to read.

*Rejected in its favour:* Rivendell's per-resource **heraldic devices** and the Conservatory's per-resource **L-system sigil-vines**. Both are the same instinct — give every item a generated mark — and both put a generated ornament into the Editorial `ResourceRow`, which is exactly the surface §6 declares Bare and §8.2 makes the most restrained in the app. One generated vine, in the margin of the thing you are actually reading, is worth more than four hundred of them in a list.

### Wildcard 2 — The Ithildin obeys the actual moon *(from the Flet, proven with the Conservatory's technique)*

Ithildin can only be seen by moonlight. So compute the real lunar phase client-side from the date — a dozen lines of arithmetic, no network, no dependency — and set `--moon` from 0.15 at new moon to 1.0 at full. The Ithildin reveal's peak opacity and bloom radius scale by it; after dark, its *resting* opacity rises too, so the pane rules are genuinely easier to see at night, which is the whole joke and it is real.

The Conservatory's discipline makes this safe rather than reckless: **`--moon` may appear only in an `opacity`, a `drop-shadow` radius, or the third (hue) slot of an `oklch()` — never in a lightness or chroma slot of any token that text sits on.** A unit test asserts it. Consequence: no phase of the moon can move a single contrast ratio in §9. Nothing functional depends on it, nobody is ever told, and a person who reads daily for a month will one evening notice that the app has been quietly keeping a calendar.

### Wildcard 3 — The room outside time *(from the Flet)*

The star field in the grain tile is **seeded once per session** — a different arrangement of stars each time you arrive — and then never changes for the entire session, however long it runs. No animation, no drift, no day/night shift, no "good evening" greeting, no relative timestamp ticking over in the chrome. Every other room in the app can tell you what time it is; the Solar refuses. You leave, you come back, and the sky is different, and you will not be able to say when it changed.

*Also rejected:* the Conservatory's **learned circadian noon** (a schedule-learning model to drive an effect we just deleted), its **duodecimal Tengwar ghost-numerals** (numerals are the one Tengwar refusal all three concepts otherwise agreed on — it is the fan-cringe move, and it is behind a decorative count nobody reads), its **attention lamp with `color-mix` legibility pooling** (text whose contrast changes as a light drifts past it is a distraction engine in a six-hour reading instrument, and it contradicts that concept's own §9), and Rivendell's **Tengwar loading skeletons** (a genuinely strange and memorable idea, and a bespoke measure-matched shadow layout for every loading surface in the app, paid on the frame budget of the moment the app is already busy — the honest version of this idea is a skeleton that looks like a skeleton).

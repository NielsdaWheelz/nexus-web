# The Solar — Rivendell concept for the third room

*Machine value: `data-theme="elvish"`. Display name: **the Solar**. Research/design only; no product code changed.*

---

## 1. Name & story

**The Press. The Study. The Solar.**

A *solar* is the real architectural name for the withdrawing room set above a great hall — the private upper chamber, glazed on the west side, where the household read, wrote, and kept its books while the hall below stayed loud. It is the one room in the building designed around late light. That makes it inevitable as the third room here: the house idiom is already rooms of a working building (Press, Study), the name is one plain English word with no fantasy costume on it, and it names *an hour* rather than a colour — which is precisely the third pole this system is missing.

> **The Study is noon.** Paper, daylight, no grain, everything told plainly.
> **The Press is midnight.** Ink, machine, reversed type, a letterpress tooth on the black.
> **The Solar is the last hour of the afternoon.** The sun has gone behind the valley wall, the lamps have just been lit, and the room is still holding the day's warmth in its wood. You are reading in Elrond's library: carved oak gone almost black, gold leaf on the spines, a fire at your back, and the whole valley outside turning. Nothing is dramatic. Everything is old, made by hand, and unhurried.

So the Solar is neither dark nor light: it is a **twilight pole**. Its ground is not black but deep olive-walnut (value near the Press, hue nowhere near it); its ink is not white but candlelit vellum; its accent is not brand-gold but aged brass. In the Press, the room is absent and the type is the whole event. In the Solar, the room is present — you can feel the wood — and the type sits in it.

---

## 2. Complete token block

Base: **twilight (dark-family)**. `color-scheme: dark` — native form controls, date pickers and UA scrollbar arrows must render dark or they punch white holes in the wood.

```css
[data-theme="elvish"] {
  color-scheme: dark;

  /* --- Surfaces: a walnut-and-moss ladder, hue ~95–105°, chroma rising as it darkens --- */
  --surface-sunken: #161a12;  /* the hearth well — inputs, wells, inset tracks */
  --surface-canvas: #1c2016;  /* the floor of the hall; olive-walnut, deliberately NOT black */
  --surface-1:      #23281b;  /* first lift — rows, cards, the reader chrome */
  --surface-2:      #2a2f20;  /* second lift — popovers, pane instrument rows */
  --surface-3:      #333926;  /* third lift — menus, sheets, the top of the stack */
  --surface-hover:  #2e3423;  /* one warm step up, never a grey wash */
  --surface-active: #3a4029;  /* pressed = closer to the lamp, not darker */

  /* --- Inks: candlelight on vellum --- */
  --ink:         #f1e7cd;  /* warm vellum white; 13.4:1 on canvas, 12.2:1 on surface-1 */
  --ink-muted:   #bdb08f;  /* aged ink; 7.7:1 on canvas, 6.4:1 on surface-2 */
  --ink-faint:   #a39878;  /* 5.8:1 canvas / 4.8:1 surface-2 — banned above surface-2 */
  --ink-machine: #b6c4b3;  /* Lothlórien sage — cooler AND recessed vs --ink; 9.3:1 canvas */
  --rail-machine: color-mix(in srgb, var(--ink-machine) 34%, transparent);
  --ink-on-accent: #1c2016; /* canvas colour back on the gold; 7.1:1 on --accent */

  /* --- Edges: carved lines, not borders --- */
  --edge:        #3b422c;  /* the default hairline — a shadow in the grain */
  --edge-subtle: #2a3020;  /* row separators; visible only as rhythm */
  --edge-strong: #67714f;  /* 3.2:1 on canvas — clears the 3:1 non-text floor */

  /* --- Accent: aged brass, never new gold --- */
  --accent:        #c9a55c;  /* 7.1:1 on canvas, 5.1:1 on surface-3 — safe as link text */
  --accent-hover:  #dcbc74;  /* the lamp flares */
  --accent-active: #a8853f;  /* pressed brass, darker and duller */
  --accent-muted:  rgba(201, 165, 92, 0.16);  /* selected-row wash */

  /* --- Ring: ITHILDIN. Attention is starlight, not firelight. --- */
  --ring: #d7e3d4;  /* cool silver-green; 12.5:1 on canvas, 9.0:1 on surface-3 */

  /* --- Status: hue AND chroma separated from the room, never hue alone --- */
  --success: #86c46f;  /* new leaf — higher chroma than any surface so it reads as signal */
  --warning: #e39a4b;  /* ember; pushed to orange so it can never be mistaken for --accent */
  --danger:  #e3736f;  /* rowan berry; 5.5:1 on canvas */
  --info:    #8fb8cf;  /* the Bruinen; 7.8:1 on canvas */

  /* --- Shadows: warm brown-black, plus a firelight rim on the top edge --- */
  --shadow-1: 0 1px 2px rgba(8, 10, 5, 0.45);
  --shadow-2: 0 4px 8px rgba(8, 10, 5, 0.52), inset 0 1px 0 rgba(240, 214, 152, 0.06);
  --shadow-3: 0 8px 18px rgba(8, 10, 5, 0.58), inset 0 1px 0 rgba(240, 214, 152, 0.07);
  --shadow-4: 0 18px 40px rgba(8, 10, 5, 0.62), inset 0 1px 0 rgba(240, 214, 152, 0.08);
  --shadow-5: 0 32px 80px rgba(8, 10, 5, 0.70), inset 0 1px 0 rgba(240, 214, 152, 0.09);

  /* --- Per-room knobs --- */
  --stroke-hairline: 1.5px;              /* gold-cast hairlines carry less luminance
                                            contrast than neutral ones; they need Press weight */
  --body-font-size: var(--text-md);      /* 1rem — reversed type, same optical up-size as Press */
  --tracking-body: 0.004em;              /* half the Press: olive ground blooms less than #0e0e10 */
  --canvas-grain-opacity: 0.05;          /* linework needs more than noise to register */
  --canvas-grain-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cg fill='none' stroke='%23e8d7a8' stroke-width='0.6' stroke-linecap='round'%3E%3Cpath d='M0 45 C 45 45 45 15 90 45 S 135 75 180 45'/%3E%3Cpath d='M0 135 C 45 135 45 105 90 135 S 135 165 180 135'/%3E%3Cpath d='M24 40 l 9 -13 M63 52 l 11 11 M114 40 l 9 -13 M153 52 l 11 11 M24 130 l 9 -13 M114 130 l 9 -13'/%3E%3C/g%3E%3C/svg%3E");
}
```

**Grain**: not noise — a **stroke-only vine-and-vein tile** at 5% opacity through the existing `body::before` mechanism. At that opacity you never see a vine; you see that the wall has a grain to it. The tile's first and last anchors share a y-value with horizontal-tangent handles so the repeat has no kink (seam must be verified at 3 zoom levels before shipping).

**Contrast audit** (WCAG 2.1, computed):

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink` on `--surface-canvas` | **13.4:1** | AAA |
| `--ink` on `--surface-1` / `--surface-2` | 12.2 / 11.2:1 | AAA |
| `--ink-muted` on canvas / surface-2 | 7.7 / 6.4:1 | AAA / AAA |
| `--ink-faint` on canvas / surface-2 | 5.8 / 4.8:1 | AA (banned above surface-2) |
| `--ink-machine` on canvas | 9.3:1 | AAA, and clearly recessed from `--ink` |
| `--accent` as text on canvas / surface-3 | 7.1 / 5.1:1 | AAA / AA |
| `--ink-on-accent` on `--accent` | 7.1:1 | AAA |
| `--ring` on canvas / surface-3 | 12.5 / 9.0:1 | ≫ 3:1 floor |
| `--edge-strong` on canvas | 3.2:1 | clears non-text 3:1 |
| `--danger` / `--warning` / `--info` / `--success` on canvas | 5.5 / 6.9 / 7.8 / 7.5:1 | all AA+ |

---

## 3. Typography

**Nothing decorative is allowed at body size.** The Solar changes the *headline* voice and leaves the reading and control voices alone.

- **UI / body — Inter, unchanged.** `--font-sans` is not overridden. Lists, controls, chat prose, dense tables stay Inter at `--text-md`, tracking `0.004em`. This is the single most important restraint in the concept: the room is carried by colour, light, and edges, not by putting a fantasy serif under a data table.
- **Reading serif — EB Garamond, already self-hosted.** The Solar overrides `--font-serif` (today a generic `ui-serif, Charter, Georgia` stack) to `var(--font-eb-garamond), Charter, Georgia, serif`. Zero new assets, and every serif surface in the app inherits a real book face.
- **Display — Cormorant (SIL OFL)**, two new woff2 files, latin subset, weight 500 + 500 italic, `--font-display`. Applied **only at ≥ `--text-xl` (1.25rem)**: pane titles, section openers, empty-state headlines, drop caps, the settings room names. Cormorant's hairline serifs die below 20px, which is exactly why the size floor is a rule and not a suggestion.
- **Machine voice — JetBrains Mono, unchanged.** Only `--ink-machine` moves, to sage `#b6c4b3`. The Machine Hand register keeps its own room-independent discipline; the Solar just gives it a cooler ink and a sage rail, so machine prose still reads as "not the house's hand."
- **Tengwar — Tengwar Telcontar** (Free Tengwar Font Project, SIL OFL), converted `.ttf → .woff2` locally, as `--font-tengwar`. Never applied to dynamic text; see §4.
- **Drop cap — Bradley Initials (DJR), COLRv1.** `.dropCap` on the reader's chapter opener and on empty-state headlines. `@font-palette-values --solarGilt { font-family: "Bradley Initials"; override-colors: 0 #c9a55c, 1 #f0d698, 2 #8a6d34; }` remaps the font's gilt palette to the Solar's brass. Browsers without COLRv1 render the default palette — graceful, no fallback branch needed. One drop cap per long-reading page, ever.

Knob values: `--body-font-size: var(--text-md)`, `--tracking-body: 0.004em`, `--stroke-hairline: 1.5px` (rationales in §2).

---

## 4. Tengwar strategy

**The hard rule, stated once and enforced by review:** *No string that came from data is ever rendered in Tengwar.* Every tengwa on screen is either (a) a baked SVG path, or (b) a fixed constant from one audited file. Every tengwar element carries `aria-hidden="true"` and sits adjacent to Latin text that says the same thing. The font is loaded; it is never bound to a text node whose content varies.

**The audit file.** `elvishInscriptions.ts` — a frozen map, one entry per inscription, each recording: the surface it belongs to, the source phrase in Latin, the language (Quenya or Sindarin), the **mode** (Quenya tehtar-on-preceding vs. Sindarin mode of Beleriand tehtar-on-following — never mixed), the tool and date of transcription (Tecendil or Glaemscribe), the reviewer, and the baked SVG path data. Baking to paths via Inkscape "object to path" / `fonttools` means no font substitution, no PUA fallback boxes, and no possibility of a future font update silently changing what the wall says.

**Where it appears — exactly five places:**

1. **The vine rule** (pane header dividers, section openers). Built from cropped tengwa *bows and stems* used as pure geometry — a repeating rule the way a Greek key is a rule. Nothing is meant to be read, so nothing can be misread.
2. **The reader's margin rail**, at a chapter opener: the chapter title, correctly transcribed once at design time only for the book's own front-matter case, at 12% opacity, warming to 40% when the rail takes hover. *Never in the text column.*
3. **Empty states**: one full inscription, correctly transcribed, behind/below the Latin message at 20% opacity.
4. **Loading skeletons** (see §10, wildcard 3): word-shaped runs assembled only from grade/series-legal sequences in the audit file — texture that is honestly not a word, rather than gibberish pretending to be one.
5. **The About/colophon page**: the one indulgence — a full Namárië-style two-colour inscription, brass on walnut, the room signing its own name.

**Where it never appears:** numerals (page numbers, counts, durations, timestamps stay Arabic and tabular, always), buttons, labels, menu items, toasts, errors, search results, filenames, or anything a user must act on. Tengwar numerals are a fan trap; the app is a reading instrument and its numbers must be scannable in a glance.

---

## 5. Ornament system

One motif, three intensities, and a token that turns it off.

**The motif is a single open vine**: one continuous stroke, asymmetric, growing out of a corner or a leading edge toward the margin, with three leaves maximum. No closed interlace anywhere — knotwork is Dwarvish and generic; Elvish is open, botanical, and unfinished.

**`--ornament-level`** (declared in `globals.css` under `[data-theme="elvish"]`, default `1`) multiplies the opacity of every ornament pseudo-element. Dense contexts set it to `0` on a container. This is the whole degradation story: one number, one place.

| Tier | Where | Treatment |
|---|---|---|
| **Illuminated** (`--ornament-level: 1`) | Empty states, reader chapter opener, settings appearance pane, About/colophon. Max **three per screen**. | Corner vine + drop cap + baked inscription. |
| **Whisper** (`0.5`) | Pane header divider, switchboard section labels, sheet top edge, primary button. | One mark, one edge. Nothing that costs a repaint. |
| **Bare** (`0`) | Every list row body, table, form field, chat prose, dense grid, virtualized list, mobile compact panes. | Colour + hairline only. |

**Techniques, per element:**

- **Corner flourish** — four absolutely-positioned 48×48 elements with a `background-image` SVG data-URI; one authored corner, mirrored to the other three with `transform: scaleX(-1) / scaleY(-1)`. Deliberately *not* `border-image`: `border-image-repeat` stretches inconsistently between engines and `mask-border` is unimplemented in Firefox.
- **Divider (the leaf rule)** — a 2px-tall element with `mask-image` of a 240×8 vine SVG, `mask-repeat: repeat-x`, `mask-position: left`. The rule is flat for 90% of its length and swells to a single leaf in the leading 24px.
- **Gold that reads as metal** — a token pair `--gilt-a: #8a6d34`, `--gilt-b: #f0d698` composed at point of use. Rings: `border: 1px solid transparent;` + `background: linear-gradient(var(--surface-1),var(--surface-1)) padding-box, conic-gradient(from 220deg, var(--gilt-a), var(--gilt-b), #fff3d0, var(--gilt-a)) border-box`. Text: `background-clip: text` **only at ≥ `--text-2xl`**, never on anything that must be read as content.
- **The arch** — the switchboard search field's top border is a shallow pointed-arch path (Rivendell's arcade), drawn as an inline SVG background 3px tall. Structural, one instance, per screen.
- **Grain** — the vine tile at 5% through the existing `body::before` (§2).

**Degradation in dense views** is not a fade — the ornament is *absent*. A row in a 400-item virtualized list has no pseudo-element to paint at all; `--ornament-level: 0` is set on the list container and the ornament rules are written so that `opacity: calc(var(--ornament-level) * .55)` collapses them without layout cost.

---

## 6. Light & motion

Two channels of attention, never confusable:

- **Hover is firelight (warm).** Ornament that was invisible warms into view: the row's leading vein, the divider's leaf, the margin-rail inscription. Warm gold, `--duration-slow` (360ms) with `--ease-bloom` — *things wake slowly.*
- **Focus is starlight (cool).** `--ring: #d7e3d4`, 2px, `--focus-ring-offset: 2px`, plus a `box-shadow: 0 0 0 5px rgba(215,227,212,0.10)` halo. `--duration-fast` / `--ease-snap` — *keyboard focus is instant, always.* Because focus is cool and hover is warm, a colour-blind or low-vision user can distinguish the two states by lightness and geometry alone, not hue.

**The reveal (our Ithildin).** Ornament sits in the DOM at `opacity: 0`. Under hover/focus it fades up and gains a two-stop `drop-shadow(0 0 4px rgba(240,214,152,.55)) drop-shadow(0 0 12px rgba(240,214,152,.25))` — tight core plus wide bloom, which is what lamplight actually does and what one shadow never looks like. `drop-shadow` (not `box-shadow`) so the glow follows the vine's alpha shape rather than its box. **Reserved to two elements per surface, maximum.**

**Exit is instant.** Enter 360ms; leave 0ms, or at most `--duration-instant` (80ms). Ornament that lingers on the way out reads as lag, and this repo has already been bitten once by chrome that retreated too slowly.

**No looping animation anywhere.** The shimmer sweep on the primary button fires **once**, on hover/focus only (`background-position` 200%→−50%, 2.8s, `iteration-count: 1`). A looping shimmer is a slot machine.

**`prefers-reduced-motion: reduce`** — the existing block already zeroes every `--duration-*`, so:
- Every reveal **snaps to its end state**. Nothing that carries meaning is motion-only; a hovered row is still visibly hovered, a focused element still visibly ringed.
- The one-shot shimmer is omitted entirely (its end state is "no shimmer," which loses nothing).
- The lamplighter progress bar (§7) becomes a static determinate fill; the indeterminate case becomes a static gold rule plus its existing text label.
- The vine grain is static in all cases and never animates.

---

## 7. Signature moments

1. **Pane header divider — the rule that grows a leaf.** The hairline under `PaneHeaderIdentity` is a masked vine: flat across the pane, swelling into one leaf at the leading 24px, in `--edge` normally and `--accent` at 40% when the pane is focused. The first thing you notice, and it costs 2px of height.
2. **ResourceRow hover — the light finds it.** No card, no shadow, no scale. A 2px gold vein at the row's leading edge *draws itself* top-to-bottom via a `mask-position` transition over 360ms, while the row lifts to `--surface-hover`. Selected rows keep the vein fully drawn in `--accent`, with the `--accent-muted` wash behind. The library becomes a page with marginal marks against the lines you care about.
3. **Switchboard header — the arcade.** The search field sits under a 3px pointed-arch rule in `--edge-strong`, and the section labels ("Recent", "Commands") take Cormorant small-caps in `--ink-faint` with a single brass leaf glyph at the label's end. The Nexus stops looking like a command palette and starts looking like a table of contents.
4. **Reader chapter opener — the gilt initial.** A COLRv1 Bradley Initials drop cap in remapped Solar brass, three lines deep, with the chapter title transcribed once in Tengwar in the margin rail at 12% opacity. The text column itself is untouched: no ornament, no tint, no vine. The artifact stays sovereign.
5. **Scrollbar — the brass rod.** 8px thumb, `border-radius: 999px`, `background: linear-gradient(90deg, #8a6d34, #d3b06a 45%, #8a6d34)`, transparent track, `scrollbar-color: #c9a55c transparent` for the standard property, at 45% opacity rising to 100% on hover. A polished rod on the edge of a shelf, not a grey slug.
6. **Selection — brass wash.** `::selection { background: color-mix(in oklch, var(--accent) 28%, transparent); color: var(--ink); }` declared globally in `globals.css` (this doesn't exist today), plus fixing `MachineText.tsx`'s two hardcoded `::selection` pairs to Solar values. Selecting a sentence should look like running a gilt nib over it.
7. **Focus ring — starlight.** §6. In a room this warm, the one cool thing on screen is where you are.
8. **Empty states — the illumination.** The full treatment lands where the content is absent: a Cormorant headline with a gilt initial, one open corner vine, the audited Tengwar inscription at 20% behind it, and the **six-pointed Eärendil star** as the mark. Six, not eight: Eärendil is the wayfinder; Fëanor's eight-ray star is a craft guild's badge and the wrong connotation for a knowledge app.
9. **Progress — the lamplighter.** The indeterminate bar is a vine, not a bar: a 1.5px gold stroke with `stroke-dasharray` animated along `pathLength`, so loading looks like a wick catching along a branch. Determinate progress fills the same path. Under reduced motion it is a static determinate rule.
10. **Toast — the hearth rim.** No ornament (it's transient), but `--shadow-4` carries `inset 0 1px 0 rgba(240,214,152,.08)`, so every lifted surface catches a line of firelight along its top edge. It's 1px and it's what makes the whole room feel lit from somewhere.
11. **Settings appearance pane — three rooms.** Not three radio labels: three small elevations, each painted in its own canvas/ink/accent trio, the Solar's carrying its leaf rule. Copy: *"The Solar — the last hour of the afternoon; gold, green, and a book left open."*

---

## 8. What we refuse

1. **No closed interlace.** No Celtic knots, no Norse braids, no woven borders. They read Dwarvish and generic-fantasy. Our vine is a single open stroke that ends in the margin.
2. **No Christmas.** Never full-saturation green against `#ffd700`. Both hues are aged: greens desaturated to olive-walnut (chroma ≤ 0.05 at low lightness), gold desaturated to brass `#c9a55c`. The gap should read as brass-on-moss, not as wrapping paper.
3. **No casino.** No looping shimmer, no particles, no sparkle, no glow on every heading. Exactly one shimmer, fired once, on interaction.
4. **No Skyrim mod.** No embossed bevels, no hammered-metal texture, no carved-stone skeuomorphism, no scroll-shaped buttons, no parchment behind every panel. Flat confident colour; the only "material" in the room is a 5% grain and a 1px rim light.
5. **No fantasy serif at body size.** Cormorant never appears below 1.25rem. Inter keeps every control, list, and dense surface.
6. **No naive transcription.** No Latin-letter-for-tengwa substitution, no unaudited glyphs, no mixed Quenya/Sindarin tehtar placement. Everything is baked, sourced, and reviewed (§4).
7. **No ornament on content.** No gradient text, tinted panels, or vines behind reading text, chat answers, or code blocks. Ornament lives on edges and in absences.
8. **No identity change.** The asterism mark, favicon, apple-icon, OG image and PWA manifest stay brand-dark. Those represent the product; the Solar is a room inside it. Oracle doesn't touch them either.
9. **No ornament that is the only carrier of meaning.** Every vine, glow, and glyph is decoration over a state that is already legible in colour, position, and text.

---

## 9. Readability & accessibility commitments

Non-negotiable, this is read for hours a day:

1. **Body ink ≥ 12:1** on canvas and surface-1 (measured 13.4 / 12.2). Muted ink ≥ 6:1 everywhere it is used. Faint ink ≥ 4.5:1 and **forbidden above `--surface-2`**.
2. **`--accent` is a legal text colour** (7.1:1 on canvas, 5.1:1 on surface-3) — link colour never needs an exception.
3. **Focus ring ≥ 3:1 against every surface it can land on** (measured 9.0–12.5:1), 2px, 2px offset, never removed, never hue-only.
4. **Status is never hue alone.** `--success` / `--warning` / `--danger` differ in lightness *and* chroma from the room and from each other, and every status surface pairs its colour with an icon or a word.
5. **Numerals stay Arabic and tabular.** Always. No exceptions for whimsy.
6. **The reading column is inviolate.** No ornament, tint, texture, or Tengwar inside the text measure — the reader's chrome and margins carry the room, the artifact does not.
7. **Reduced motion preserves meaning** by snapping to end states, never by removing an affordance (§6).
8. **The elvish reader theme is a separate proof.** `.readerThemeLight/.readerThemeDark` are documented as independent of the app room; a `.readerThemeElvish` block (if built) must independently clear the same contrast floors and must be shown to *compose with*, not fight, `[data-theme="elvish"]` — the same proof Two Rooms had to make.
9. **Extend the existing per-theme contrast test.** `EntrySurfaces.browser.test.tsx:367` iterates `["dark","light"]`; the Solar joins that array and clears 4.5:1 text / 3:1 ring like the other two, or it doesn't ship.
10. **`color-scheme: dark`** so native controls, scrollbar arrows, and autofill don't punch white through the wood.

---

## 10. Three OOD wildcards

**1. The living marginalia — one vine that is progress, position, and memory.**
The reader's margin rail carries a single continuous SVG vine spanning the document's full height. Its stroke is drawn only as far as your furthest-read position (`stroke-dasharray` against `pathLength="1"`), so the vine *grows as you read the book*. At every highlight you have made, a leaf sprouts from the vine at that document offset, tinted by the highlight's ink. Your current position is a single brass bud. It is simultaneously the progress bar, the highlight map, and the document's illumination — three widgets collapsed into one drawing, and the drawing is different for every book because you made it. Nothing about it is decorative-only: hovering a leaf scrubs to that highlight.

**2. Heraldic devices for every resource.**
Tolkien's elvish heraldry has actual rules: circular devices, lozenge devices, and *the number of points touching the rim denotes rank*. Give every resource a deterministic device generated from its id — a 18px SVG in the row's leading gutter, circle or lozenge by media kind, rim-points by a real signal (highlight count bucketed 2/4/6/8, so a book you've worked hard on literally attains a king's device), and stroke colour from `--edge-strong` → `--accent` by recency. The library becomes a wall of shields you learn to recognise before you read the titles — a small reusable geometric idea used endlessly, exactly like the three-dot asterism, and the first navigation aid in this app that gets *earned* rather than assigned.

**3. Tengwar skeletons — the page arrives already written, and translates as it loads.**
The genuinely strange one. Loading placeholders in the Solar are not grey bars. They are lines of Tengwar at 8% opacity, laid out at the true measure and line count of the content that is coming, which **fade out as the Latin text fades in** — as though the page had always been there in Elvish and the app is translating it in front of you. The glyph runs are assembled only from grade/series-legal sequences drawn from the audit file, in word-shaped lengths, so a reader of Tengwar sees plausible word-shapes rather than gibberish; they are `aria-hidden`, never announced, and carry the normal `aria-busy` semantics underneath. It reframes the entire product metaphor in one interaction: Nexus is not fetching your library, it is *rendering something that was always written* — which is, more or less, exactly what a reading instrument is for.

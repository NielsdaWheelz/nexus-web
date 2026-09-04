# The Craft: technique cookbook for the "elvish" (third-room) theme

## 1. Precedents — what separates premium themed UI from cheap

- **League of Legends client / "Hextech" visual language**: ornament is *load-bearing*, not decorative filler — shapes intersect and converge to draw the eye toward the actual interactive target; important buttons get the ornament, secondary chrome stays flat. Translucent panels + generous negative space keep an ornate language legible. The lesson for elvish: gild the moments that matter (page title, primary CTA, section dividers), leave body text and dense lists nearly bare.
- **Final Fantasy VII UI (CodePen "Kaizzo/aGWwMM")** and **PropJockey's "100% CSS Fantasy Buttons"**: all-CSS multi-layer `box-shadow` stacks fake bevels/ridges without images — `inset` + outer shadows in alternating light/dark stop pairs read as carved stone or forged metal. Directly reusable for elvish button/panel bevels.
- **Kenney "Fantasy UI Borders"** (CC0, kenney.nl/assets/fantasy-ui-borders): 140 sliceable 9-patch frame PNGs — good *reference* for what corner-flourish proportions look like even though we'll build SVG, not raster.
- **Consistent finding across "premium vs cheap" design writing**: premium is restraint + a few extremely well-executed motifs repeated consistently, not maximal ornament everywhere. "Luxury is not about adding — it's about removing until only excellence remains." Cheap fantasy UI over-textures every surface; premium fantasy UI reserves texture/gilding for edges, dividers, and moments of emphasis, and lets 90% of the surface stay calm (parchment/ink flat color) — exactly the "Two Rooms" discipline this repo already has (grain opacity token, hairline stroke token). Elvish should follow the same law: one signature ornament motif (a leaf-vine + Tengwar-glyph accent), used sparingly and consistently, beats five different flourishes.

## 2. Ornamental technique cookbook

### 2a. Filigree frames via `border-image` + SVG
Production pattern (verified from charlottedann.com "Fancy Frames with CSS"): embed a 3×3-sliceable SVG as a data URI, let `border-image-slice` cut corners/edges out of it.

```css
.elf-frame {
  border: 18px solid transparent;
  border-image-slice: 33% fill;
  border-image-width: 18px;
  border-image-source: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 90 90'>...vine corner path, repeated 4x via <use> rotations...</svg>");
  border-image-repeat: stretch; /* 'round' varies edge aspect ratio inconsistently between Safari/Chrome — avoid for edges, only stretch or space */
}
```
- Corners are the hard part in every writeup: draw ONE corner motif, then use 4× `<use transform="rotate(90 45 45)">` inside the SVG so slicing is symmetric — much easier than hand-authoring 4 corners.
- `border-image-slice: 33% fill` — the `fill` keyword paints the SVG's center under the box's own background, letting the vine artwork bleed slightly into the panel without a second layer.
- Corner-flourish ALTERNATIVE (simpler, more controllable): four independent `::before`/`::after`-style corner elements (need actual sibling `<i>` tags or a wrapping div per corner since pseudo-elements only give you two per box) positioned `absolute` top-left/top-right/etc., each holding a small vine SVG as `background-image`, `transform: scaleX(-1)` to mirror for the opposite corner instead of authoring twice. This avoids all `border-image-repeat` cross-browser flakiness and is the recommended default for elvish panel frames.
- `mask-border` (same shape as border-image but for masking content) is NOT implemented in Firefox — do not depend on it.

### 2b. Vine-edged panels via `mask-image`
For a panel whose bottom/top edge is a scalloped vine silhouette rather than a straight line (tylergaw.com "Flexible Repeating SVG Masks", verified pattern):

```css
.elf-panel-vine-edge {
  --vine: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 32'><path d='M0 16 C 20 0, 40 32, 60 16 S 100 0, 120 16 240 16 240 16' fill='black'/></svg>");
  -webkit-mask-image: var(--vine);
  mask-image: var(--vine);
  mask-repeat: repeat-x;
  mask-position: bottom;
  mask-size: 240px 32px;
}
```
Seamless-tiling rule (verified): the path's first and last points must sit at the **same y-coordinate**, and the bezier handles must be flat/tangent to horizontal right at the tile boundary — otherwise you get a visible kink every repeat. Author the vine motif in a 240×32 (or similar wide-short) viewBox in Figma/Illustrator/Inkscape, check start/end tangents, export path `d` only, inline as data URI (keeps it in the CSS file, no network request, respects the "self-hosted only" repo rule already in place for fonts).

### 2c. Seamless leaf/vine/star tiling backgrounds
Same data-URI-as-`background-image` technique used for `--canvas-grain-image` today. For elvish, build a **very low-opacity** (2–4%, matching the existing `--canvas-grain-opacity` discipline) repeating leaf-vein or star-field SVG pattern:
```css
[data-theme="elvish"] {
  --canvas-grain-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>...tileable leaf-vein linework, stroke only, no fill...</svg>");
  --canvas-grain-opacity: 0.035;
}
```
Keep pattern **stroke-only** (no fills) at low opacity — filled leaf shapes at any visible opacity read as "wallpaper", stroke-only linework at 2-4% reads as "paper with texture," matching the existing Press/Study grain philosophy. Use `<pattern>` inside the SVG (native seamless tiling primitive) rather than manually replicating shapes — smaller data URI, guaranteed seamlessness.

### 2d. Gold that reads as metal, not `#FFD700`
Flat gold (`#FFD700`) fails because real metal shows **directional light** — multiple value steps, not one hue. Verified technique (ibelick.com + hexcolor.co gold-gradient + conic-gradient border articles), a 7-stop 45° gradient simulating a light source:
```css
--elf-gold-metal: linear-gradient(
  135deg,
  #7a5a23 0%,
  #d8b463 12%,
  #fff3d0 24%,   /* hot highlight */
  #c99a4a 38%,
  #8f653b 52%,
  #f0be79 68%,
  #a97c3f 82%,
  #6b4a20 100%
);
```
Apply to text via `background-clip: text; -webkit-text-fill-color: transparent;` (only for large display glyphs / drop caps — never body text, contrast is unreliable). Apply to borders via the transparent-border double-background trick (verified, web.dev conic-gradient article + community pattern):
```css
.elf-gold-ring {
  border: 3px solid transparent;
  background:
    linear-gradient(var(--surface-1), var(--surface-1)) padding-box,
    conic-gradient(from 45deg, #6b4a20, #f0be79, #fff3d0, #c99a4a, #6b4a20) border-box;
}
```
This is strictly better than `border-image` for a *ring* (circular avatar frames, badge borders) because `conic-gradient` sweeps around a center point naturally — punch a hole with `mask: radial-gradient(...)` if you need a true annulus without inner fill.

**Shimmer** (verified ibelick.com pattern, adapt sparingly — see §2f motion guardrails): a `::after` pseudo-element, `background: linear-gradient(100deg, transparent 40%, rgba(255,255,255,.5) 50%, transparent 60%)`, `background-size: 250% 100%`, animate `background-position` from `200% 0` to `-50% 0` over 2.5–3.5s, `animation-iteration-count: 1`, triggered on hover/focus only (not looping ambiently) — a looping shimmer across many gold elements reads as "cheap casino," a single sweep on interaction reads as "enchanted."

Why flat gold fails, concretely: at the token-ladder level, define gold as a **gradient token pair** not a single hex — `--accent-gold-a` / `--accent-gold-b` / `--accent-gold-highlight` — and compose the gradient at point of use, so the metal effect is consistent everywhere it appears without repeating 7 stops in every rule.

### 2e. OKLCH green surface ladder (7 steps, stays alive in dark UI)
Flat desaturated dark greens go muddy/murky because hue drifts as lightness drops in sRGB/HSL. OKLCH holds perceived hue constant across lightness, which is exactly what a dark canvas → hover → active ladder needs. Recommended anchor hue for a living forest-green (not olive, not teal): **oklch hue ≈ 150–155°** (verified as the "leaf green" band across OKLCH tools surveyed — Atmos, oklch.fyi, ColorRamp). Sketch ladder (verify final values in-browser against existing `--surface-canvas`…`--surface-3` contrast ratios from globals.css):

```css
[data-theme="elvish"] {
  --surface-canvas: oklch(16% 0.035 155);   /* near-black forest floor, NOT pure black */
  --surface-1:      oklch(19% 0.040 152);
  --surface-2:      oklch(23% 0.045 150);
  --surface-3:      oklch(27% 0.050 148);
  --surface-hover:  oklch(30% 0.045 150);
  --surface-active: oklch(25% 0.055 152);
  --surface-sunken: oklch(13% 0.030 156);
  --ink:            oklch(92% 0.02  120);   /* warm parchment-white, slight gold lean, not cool white */
  --ink-muted:      oklch(72% 0.03  135);
  --accent:         oklch(78% 0.14  85);    /* gold-amber, NOT green — accent must contrast the green field */
}
```
Key rule verified across every OKLCH-ramp resource: keep **chroma (C) low and rising slowly** as lightness drops toward black (e.g. 0.030→0.055 across 7 steps) — pushing chroma high at low lightness is exactly what produces "murk" (muddy near-black greens); OKLCH lets you raise L slightly per step while barely moving C, so mid-ladder steps stay distinguishably green rather than collapsing to near-black-grey. Gamut-clip risk: high-chroma OKLCH near L<20% can fall outside sRGB — always render through `color-mix(in oklch, ...)` or check with a gamut-mapping tool before shipping; Chrome/Firefox/Safari all now support `oklch()` natively (2025+), no polyfill needed for a single-user prototype.

### 2f. Glow / Ithildin reveal pattern
No ready-made CSS recipe existed in search results specifically for the moon-door effect, so this is original synthesis from the mask + transition primitives above (still concrete/buildable):
```css
.elf-ithildin {
  position: relative;
}
.elf-ithildin::after {
  content: "";
  position: absolute; inset: 0;
  background-image: var(--tengwar-inscription-svg); /* line-art Tengwar glyphs, stroke only */
  -webkit-mask-image: var(--tengwar-inscription-svg);
  mask-image: var(--tengwar-inscription-svg);
  mask-repeat: no-repeat;
  opacity: 0;
  filter: drop-shadow(0 0 0 transparent);
  transition: opacity 480ms ease, filter 480ms ease;
}
.elf-ithildin:hover::after,
.elf-ithildin:focus-visible::after {
  opacity: 1;
  filter: drop-shadow(0 0 6px oklch(85% 0.05 200 / 0.9))
          drop-shadow(0 0 14px oklch(85% 0.05 200 / 0.5));
}
```
Mechanism: the inscription is invisible (opacity 0, glow-less) in ordinary "daylight" state — line art is present in the DOM/paint but not perceived — and on hover/focus it fades up AND gains a layered `drop-shadow` glow (two stacked shadows, tight + wide radius, mimics moonlight bloom better than one shadow). Use `drop-shadow` (not `box-shadow`) because it follows the alpha shape of the masked SVG, not the bounding box — critical for glyph-shaped glow. Reserve for exactly one or two elements (a section title, a "reveal secrets"/expand affordance) — this is the single most expensive-looking, most overuse-prone effect in the whole cookbook.

Cheaper variant for elements that must not cost a `filter` repaint: swap `filter: drop-shadow` for a second blurred copy of the same mask underneath at larger `mask-size`, opacity-crossfaded — avoids GPU filter cost on every frame of the transition, only pays it twice (paint in, paint out).

### 2g. Chrome-level theming: scrollbar / selection / caret / focus / details-summary
All verified-standard, straightforward to namespace under `[data-theme="elvish"]`:
```css
[data-theme="elvish"] {
  scrollbar-color: var(--accent-gold-a) var(--surface-2); /* standard, Firefox+Chrome 121+ */
  color-scheme: dark; /* keeps native form controls, scrollbar arrows dark-mode-correct */
}
[data-theme="elvish"] ::-webkit-scrollbar { width: 12px; }
[data-theme="elvish"] ::-webkit-scrollbar-thumb {
  background: linear-gradient(var(--accent-gold-b), var(--accent-gold-a));
  border-radius: 6px;
  border: 2px solid var(--surface-canvas); /* creates a padding ring so the thumb looks inset, not full-bleed */
}
[data-theme="elvish"] ::selection {
  background: color-mix(in oklch, var(--accent-gold-a) 35%, transparent);
  color: var(--ink);
}
[data-theme="elvish"] input, [data-theme="elvish"] textarea {
  caret-color: var(--accent-gold-a);
}
[data-theme="elvish"] :focus-visible {
  outline: 2px solid var(--accent-gold-a);
  outline-offset: 2px;
  border-radius: var(--radius-sm); /* elvish should curve every focus ring, never a square blunt outline */
}
[data-theme="elvish"] details > summary {
  list-style: none;
  cursor: pointer;
}
[data-theme="elvish"] details > summary::before {
  content: "❧"; /* or a Tengwar tengwa glyph as the disclosure marker */
  display: inline-block;
  margin-right: 0.5em;
  color: var(--accent-gold-a);
  transition: transform 200ms ease;
}
[data-theme="elvish"] details[open] > summary::before { transform: rotate(90deg); }
```
`scrollbar-color` is the modern standard (verified MDN); still pair with `::-webkit-scrollbar-*` for Safari/older-Chromium — both are needed, neither alone covers everything as of 2026.

### 2h. Variable fonts / color fonts for gold-inlaid initials
COLRv1 (verified: Chrome 98+, Firefox, Edge, Samsung Internet all support it; `font-palette` CSS property lets you swap the font's built-in color palette) is real and shippable in 2026 for a single-user Chromium/Firefox-target prototype. Concretely:
- **Bradley Initials (DJR)** — a real COLRv1 decorative-initial typeface built specifically for gilded/ornamental drop caps (djr.com tools page has a live beta). Worth trying as the drop-cap face for elvish chapter/section openers — it is literally designed for this exact purpose (illuminated-manuscript-style initials).
- Practically: self-host the COLRv1 `.woff2` beside the existing fonts, apply only to a single `.drop-cap` class (first letter of a long-form reading surface), define a custom `@font-palette-values` block remapping its internal palette slots to the elvish gold ramp (`--accent-gold-a/b`) so the initial's gilding matches the rest of the theme instead of using the font's default palette.
- Fallback: browsers without COLRv1 (rare in 2026 but Safari lagged) just render the font's default/first palette — no breakage, graceful degradation is automatic.
- This is a genuinely differentiated, low-cost, high-impact single touch — one drop cap per long-reading page, not a UI-wide font swap.

### 2i. Performance & taste guardrails
- **`filter`/`backdrop-filter: blur()` cost**: verified as one of the most expensive paint operations, especially `backdrop-filter` (forces continuous repaint of everything behind it while scrolling). Rule for elvish: use `blur()`/`backdrop-filter` on at most 1–2 fixed/rarely-repainting elements (e.g. a modal scrim), never on scrolling list rows or anything animated every frame.
- **`prefers-reduced-motion`**: verified pattern — wrap ALL non-essential animation (shimmer sweep, Ithildin glow fade, hover scale) in `@media (prefers-color-scheme: no-preference)`... actually correct query is `@media (prefers-reduced-motion: no-preference)`, and provide the *static end state* (not the animation) as the reduced-motion fallback, never just "remove the effect entirely" — e.g. Ithildin under reduced-motion should snap straight to the glowing state on focus/hover with `transition: none`, not stay permanently dark.
- **Ornament yields to readability**: never apply the gold-gradient `background-clip: text` treatment, Tengwar accents, or textured backgrounds behind body copy or any run of reading text — confirmed by the project's own "Two Rooms" discipline (grain opacity 2-4%, hairline strokes) and by every "premium vs cheap" source found: restraint at the body-copy layer is what makes the ornamental accents at the edges read as intentional rather than decorative noise.
- Compose ornament as **opt-in per-surface classes/tokens** (`.elf-frame`, `.elf-ithildin`, `--canvas-grain-*`) exactly like the existing oracle theme's scoped-token pattern (`[data-theme="oracle"]` block + `OracleThemeWrapper.tsx`) rather than baking flourishes into base component CSS — keeps the token-discipline gate (`check-css-tokens.mjs`) happy and keeps the effect removable/tunable in one place.

## 3. Multi-theme architecture precedent (3+ themes in the wild)

- **`light-dark()` CSS function** (Baseline 2024, verified via daverupert.com): `color-scheme: light dark;` on `:root` + `--token: light-dark(lightValue, darkValue);` lets the UA resolve per-user-preference natively, ~0.5kb gzip for ~500 variables, zero JS. Not directly applicable to a 3-theme system (light-dark only takes 2 args) but the **pattern generalizes**: this repo's existing architecture (bare `:root` = dark defaults, `[data-theme="light"]` override block, `[data-theme="oracle"]` fully-scoped extra block) is already the *right* shape for N themes — elvish should be a fourth sibling block, `[data-theme="elvish"] { --surface-canvas: ...; }`, same shape as oracle's, not a light/dark toggle extension.
- **FOUC avoidance for SSR cookie theming** (verified pattern, matches what's already in `apps/web/src/app/layout.tsx`): set `data-theme` on `<html>` server-side from the cookie before first paint — this repo already does this correctly (`nx-theme` cookie → `data-theme` attribute in layout.tsx), so elvish just needs `"elvish"` to become a valid value of `AppTheme` in `apps/web/src/lib/theme/cookie.ts` and a new option in `SettingsAppearancePaneBody.tsx`. Also set `color-scheme: dark` (elvish is a dark-leaning room) inside the elvish block so native form controls / scrollbar arrows render correctly without extra CSS.
- **`<meta name="theme-color">`**: should be updated per-theme too (verified as standard practice for PWA / mobile browser chrome tinting) — if the repo sets this statically today, elvish needs either a per-theme meta value swapped via the same server-side cookie read, or (simpler for a prototype) a `<meta name="theme-color" media="(prefers-color-scheme: dark)">`-style duplicate isn't sufficient for 3 themes since media queries can't detect `data-theme` — this one genuinely needs a small JS/SSR touch (read cookie, emit matching `<meta>` value) alongside the existing `data-theme` cookie read.
- **Namespacing**: oracle's own-tokens-and-fonts pattern (scoped variable names, own font stack, wrapped in a `display:contents` wrapper div) is the correct precedent to copy exactly for elvish — do NOT try to reuse light/dark's semantic token *values*, define elvish's own full ladder the way oracle does, so elvish can diverge as far as it wants (different radius scale, different motion easing for shimmer) without leaking into or being constrained by the two existing rooms.

## 4. Typography

Font pairing research (Typewolf, fontalternatives.com, Google Fonts specimens) plus known variable-font/OpenType feature facts:

| Face | Role fit | True italics? | Tabular figures? | Notes |
|---|---|---|---|---|
| **Cormorant** (+ Cormorant Garamond, Cormorant SC, Cormorant Upright Italic) | Display / large headings only | Yes, genuinely calligraphic true italic (not slanted roman) — Cormorant's italic is one of the most praised free display italics | Yes, via OpenType `tnum` feature | High contrast, hairline serifs, "engraved" quality at large sizes; unreadable/too thin below ~20px — display-only, exactly like this repo's existing IM Fell/UniFraktur oracle display faces |
| **Alegreya** (+ Alegreya SC) | Body text candidate | Yes, true italic, humanist calligraphic | Yes | Designed for long-form reading (literary/humanist brief), more weight variety and better x-height for body copy than Cormorant — best candidate for elvish's actual reading-surface body font if EB Garamond (already in repo) isn't reused |
| **Spectral** | Body text / alternate | Yes, true italic | Yes, `tnum` supported | Designed explicitly for screen reading (Google's own "designed for the screen" brief), 8 weights, warmer and slightly lower-contrast than Cormorant — a safe, very readable body choice, less "elvish-flavored" than Alegreya but more neutral if you want ornament to carry all the theme's personality |
| **Marcellus** | Accent / small-caps display | No italic variant exists | — | Roman-inscription feel, single weight — good for a "carved stone" label/eyebrow treatment, not for headings needing italic emphasis |
| **Philosopher** | Avoid | Has italic but geometric/didone-ish, reads more "sci-fi poster" than woodland-elvish | — | Skip — tonally wrong |
| **EB Garamond** (already self-hosted in repo) | Reuse as-is for elvish body copy | Yes, true italic (Google Fonts EB Garamond ships real italics) | Limited | Reusing the existing font avoids adding a new self-hosted asset at all — strongest "do less" option; pair with Cormorant only for display since the two share Garamond ancestry and won't clash |

**Recommendation**: display = **Cormorant** (large titles, drop caps, section openers) sized ≥28px only; body/UI = **reuse EB Garamond already in the repo** (zero new font weight to self-host, and it already passes whatever hinting/legibility bar the Study theme required) OR **Alegreya** if you want the body text itself to feel more "illuminated manuscript" than the Study's Garamond — Alegreya is available as static + variable woff2 from Google Fonts, self-hostable, genuinely built for reading.

**Tengwar**: **Tengwar Annatar** by Johan Winge (verified: widely cited as the closest to Tolkien's own calligraphic hand, available as free `.ttf` via dafont.com and the Free Tengwar Font Project on SourceForge) is the right pick for ACCENT use — section dividers, a watermark-style word in a corner, the disclosure-marker glyph in §2g. Critical constraint already given in the brief and reconfirmed by every Tengwar-font source: these are **transliteration fonts** (they map Latin keystrokes to tengwa glyphphs via a phonetic mode, e.g. "Quenya mode" or "English mode") — never usable for real UI text, only for short decorative inscriptions you author once as a fixed string (e.g. a section title transliterated once, baked as a static SVG/masked accent — see the Ithildin pattern in §2f) not as a live font applied to dynamic app copy. License note: Tengwar Annatar is freeware but not explicitly public-domain — irrelevant per the brief (no licensing constraints for this private single-user prototype) but still confirm the `.ttf` is redistributable as a self-hosted woff2 conversion (fontsquirrel/other converters can produce woff2 from the ttf locally).

**COLRv1 gold-inlaid initial**: see §2h — Bradley Initials (DJR) is the concrete, real, currently-fetchable example.

## Sources
- [Fancy frames with CSS — charlottedann.com](https://charlottedann.com/article/fancy-frames-with-css)
- [border-image CSS property and SVG — pvgr.eu](https://www.pvgr.eu/en/article/border-image-css-and-svg.html)
- [Fantasy Game UI — CodePen](https://codepen.io/5180/pen/KKdaMzE)
- [Fantasy Game Buttons — CodePen](https://codepen.io/manelsworld/pen/YvPVaw)
- [Final Fantasy VII UI — CodePen](https://codepen.io/Kaizzo/pen/aGWwMM)
- [100% CSS Fantasy Buttons — CodePen](https://codepen.io/propjockey/pen/poqKrGe)
- [Kenney Fantasy UI Borders](https://kenney.nl/assets/fantasy-ui-borders)
- [Creating a metallic effect with CSS — ibelick.com](https://ibelick.com/blog/creating-metallic-effect-with-css)
- [8 Amazing Metallic Effects — Speckyboy](https://speckyboy.com/metallic-effects-css-javascript/)
- [Gold (Metallic) gradient — hexcolor.co](https://hexcolor.co/gradient/D4AF37)
- [Use conic gradients to create a cool border — web.dev](https://web.dev/articles/conic-gradient-border)
- [Metallic Gradient Borders — CodePen](https://codepen.io/yuenletsgo/pen/gOVXBQb)
- [CSS: Flexible Repeating SVG Masks — tylergaw.com](https://tylergaw.com/blog/css-repeating-svg-masks/)
- [CSS mask-image: Gradient Masks, SVG Masks & Creative Effects — savvy.co.il](https://savvy.co.il/en/blog/css/css-mask-image/)
- [Apply effects with CSS mask-image — web.dev](https://web.dev/articles/css-masking)
- [Inverted themes with light-dark() — daverupert.com](https://daverupert.com/2026/04/inverted-light-dark/)
- [The Many Faces of Themeable Design Systems — Brad Frost](https://bradfrost.com/blog/post/the-many-faces-of-themeable-design-systems/)
- [OKLCH palette generator — Atmos](https://atmos.style/playground)
- [ColorRamp](https://www.colorramp.com/)
- [Ramps Studio](https://www.ramps.studio/)
- [OKLCH Color Picker & Converter](https://oklch.net/)
- [Custom Scrollbars In CSS — ishadeed.com](https://ishadeed.com/article/custom-scrollbars-css/)
- [CSS scrollbars styling — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scrollbars_styling)
- [Focus ring — Bootstrap docs](https://getbootstrap.com/docs/5.3/helpers/focus-ring/)
- [COLRv1 and CSS font-palette — CSS-Tricks](https://css-tricks.com/colrv1-and-css-font-palette-web-typography/)
- [COLRv1 Color Gradient Vector Fonts in Chrome 98 — Chrome for Developers](https://developer.chrome.com/blog/colrv1-fonts)
- [Bradley Initials DJR COLR v1 Beta](https://tools.djr.com/misc/bradley-initials/)
- [What is COLRv1? — Nabla](https://nabla.typearture.com/whatisCOLRV1.html)
- [prefers-reduced-motion — web.dev](https://web.dev/articles/prefers-reduced-motion)
- [prefers-reduced-motion CSS media feature — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- [The Visual Language of Hextech — League of Legends](https://nexus.leagueoflegends.com/en-us/2016/12/the-visual-language-of-hextech/)
- [The UI of League of Legend's Client — Medium](https://medium.com/@1537148253135/the-ui-of-league-of-legends-client-d6d8b947365a)
- [10 Minimalist luxury websites — TYPZA](https://www.typza.com/blog/10-minimalist-luxury-websites)
- [Cormorant Font Combinations — Typewolf](https://www.typewolf.com/cormorant)
- [Fonts That Pair With Cormorant Garamond — fontalternatives.com](https://fontalternatives.com/pairings/cormorant-garamond/)
- [Cormorant Garamond — Google Fonts](https://fonts.google.com/specimen/Cormorant%2BGaramond)
- [Tengwar Annatar Font — dafont.com](https://www.dafont.com/tengwar-annatar.font)
- [Free Tengwar Font Project — SourceForge](https://sourceforge.net/projects/freetengwar/)
- [Tengwar Fonts — Download, Install & Use](https://learningelvish.com/blog/tengwar-font-guide)

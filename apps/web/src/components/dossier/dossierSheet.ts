// The dossier article's stylesheet, adopted by its shadow root. It is written
// in app tokens, which inherit through the host, so a theme switch restyles the
// article without a rebuild. The host inherits the machine face and ink from
// MachineText. The find highlights are repeated here so find does not depend on
// document rules reaching into a shadow tree (chromium does that; others are
// unprobed).
const CSS = `
:host { display: block; contain: layout paint; }
article { max-width: 72ch; margin: 0 auto; padding: var(--space-4) var(--space-1) var(--space-12); line-height: var(--leading-loose); overflow-wrap: anywhere; }
section, header { min-width: 0; }
section + section { margin-top: var(--space-10); padding-top: var(--space-6); border-top: var(--stroke-hairline) solid var(--edge-subtle); }
h2, h3, h4 { margin: 0 0 0.8em; color: var(--ink); font-family: var(--font-sans); line-height: var(--leading-tight); text-wrap: balance; }
h2 { font-size: var(--text-2xl); }
h3 { margin-top: 2em; font-size: var(--text-xl); }
h4 { margin-top: 1.75em; font-size: var(--text-md); }
p, ol, ul, dl, blockquote, pre, figure, table { margin: 0 0 1.25rem; }
ol, ul { padding-inline-start: 1.5rem; }
li + li { margin-top: 0.5rem; }
dt, strong { color: var(--ink); font-weight: var(--weight-bold); }
dd { margin: 0.35rem 0 1rem 1rem; }
blockquote { padding-inline-start: 1.15rem; border-inline-start: 3px solid var(--edge-strong); color: var(--ink-muted); }
code { padding: 0.08em 0.28em; border-radius: var(--radius-xs); background: var(--surface-2); font: inherit; font-size: 0.92em; }
pre { overflow: auto; padding: var(--space-4); border: var(--stroke-hairline) solid var(--edge); border-radius: var(--radius-sm); background: var(--surface-2); line-height: var(--leading-normal); }
pre code { padding: 0; background: transparent; }
figure { margin-inline: 0; }
figcaption { margin-top: 0.65rem; color: var(--ink-muted); font-size: var(--text-sm); }
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: var(--text-sm); }
th, td { padding: 0.65rem 0.8rem; border: var(--stroke-hairline) solid var(--edge); text-align: start; vertical-align: top; }
th { background: var(--surface-2); color: var(--ink); font-family: var(--font-sans); }
.dossier-lede { color: var(--ink); font-size: var(--text-lg); }
.dossier-definition, .dossier-example, .dossier-warning, .dossier-diagram { margin: 1.5rem 0; padding: 0.9rem 0 0.9rem 1rem; border-inline-start: 3px solid var(--accent); }
.dossier-example { border-color: var(--success); }
.dossier-warning { border-color: var(--warning); }
.dossier-diagram { overflow-x: auto; border-color: var(--info); white-space: pre-wrap; }
.dossier-steps { padding-inline-start: 1.65rem; }
.dossier-muted { color: var(--ink-muted); }
.dossier-citation { margin: 0 0.08rem; padding: 0 0.25rem; border: var(--stroke-hairline) solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--accent); font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans); vertical-align: super; cursor: pointer; }
.dossier-citation sup { vertical-align: baseline; font-size: inherit; }
.dossier-citation:hover { border-color: var(--edge); background: var(--surface-hover); }
.dossier-citation:focus-visible { outline: var(--focus-ring-width) solid var(--ring); outline-offset: var(--focus-ring-offset); }
::highlight(nexus-find-all) { background-color: var(--highlight-yellow); color: inherit; }
::highlight(nexus-find-active) { background-color: rgba(255, 193, 7, 0.65); color: inherit; text-decoration: underline double currentColor; text-underline-offset: 0.14em; }
@media (forced-colors: active) { ::highlight(nexus-find-all), ::highlight(nexus-find-active) { background-color: Highlight; color: HighlightText; } }
@media print { section + section { border-color: currentColor; } pre, table, figure { break-inside: avoid; } }
`;

let sheet: CSSStyleSheet | null = null;

/** Built on first use: constructable sheets exist only in the browser. */
export function dossierSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
  }
  return sheet;
}

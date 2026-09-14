status: open
origin: 2026-09-13 bounded reader paint review
area: vector admission / pane DOM reference scope

typed local paint references preserve original SVG IDs, but two panes may mount
the same IDs in one document. `reader_publication_render.py` retains source IDs;
`HtmlRenderer` uses ordinary DOM mounts. a fragment URL may therefore select a
definition from another pane. definitions outside the selected SVG/unit also
need an explicit bounded source dependency before that scope can be isolated.

inspect the actual browser behavior before changing the renderer. if IDs are
document-scoped, rebind display IDs and all SVG local references per admitted
lease, preserving canonical source IDs and locator coordinates. preserve literal
percent signs by URL-decoding once at publication and URL-encoding before CSS
quoting. do not silently fetch another current generation or duplicate whole SVGs.

acceptance: two simultaneous panes with conflicting gradients render their own
definitions; escaped, percent-encoded and quoted IDs resolve correctly; no local
reference initiates network access or escapes the selected generation.

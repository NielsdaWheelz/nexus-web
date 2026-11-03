# an embed-only outline row breaks the row anatomy

problem: a note whose whole body is a resource embed shows the embedded
resource's read-only `ResourceOutlineRow` inside its outline row. the row has two
identities, the containing occurrence and the displayed resource, and the embed's
own controls (`⋯`, the open link, the disclosure) trail its content at the row's
far end. they keep `ResourceOutline.module.css`'s minimum sizes, so the row's one
line is as tall as those controls: 28px with a mouse and 52px with touch, against
the outline's 25px and 32px rows. the embed's `•` stands alone at the right edge.

impact: every embed-only note stands 3px taller than its siblings on a desktop and
20px taller on a phone, with a second, distant set of controls.

evidence, lab run `20261102-134037-36bb62a0ff5c` (case `adversary-L3-e-embed`):
- at 1180 the row is 28px: the embed item is 24px plus 2px of padding on each side;
  at 390 touch it is 52px: 44px plus 4px on each side.
- the rows were 49px and 76px until the outline host laid the embed out inline
  (`NoteEditor.module.css`, `.outline div.note-object-embed`); the extra line was
  prosemirror's trailing break after the block embed (run
  `20261102-131155-e6d2c7c6c800`). only the control height remains.
- the 24px comes from `--outline-control-block-size` on `.control` and the
  `min-height` of `.actions`; the 44px from `Control.module.css`'s coarse-pointer
  minimum on `⋯`, which no context token lowers.

why the outline css does not fix it: shrinking `⋯` would style another module's
internals. sizing the embed's controls belongs to the resource row anatomy, which
the companion-density work rewrites in `ResourceOutline.module.css`. keep separate
semantic owners even if the visual controls merge; do not repair density by
reparenting the host, negative margins or a guessed overlay.

resolved when an embed-only row measures 25px with a mouse and 32px with touch,
with both identities' content, actions, selection, focus and history intact,
either because the embed's controls move into the containing row's menu or
because an in-row control size lands in `ResourceOutline.module.css`.

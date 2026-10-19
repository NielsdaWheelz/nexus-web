# reader character shortcuts lack focus ownership

status: open · origin: 2026-10-14 shortcut-removal review · area: web / reader, accessibility

`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:280-313` handles
`g`, `shift+g`, `g e` and `g c` at document scope while the pane is active,
without requiring focus in the reader or offering an off switch.
`useAnnotationVerbs.ts:164-176` in the same directory handles `n` at window
scope when a selection exists, without checking prevented events, composition
or overlay ownership. these shortcuts were never governed by custom bindings.

impact: typing outside an editor can trigger reader actions; a live selection
can admit a note command beneath an overlay. character-only shortcuts require
focus scoping, an off switch or remapping under
[wcag 2.1.4](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html).
this finding is source review, not a browser reproduction.

prerequisites: an authenticated reader with selectable text. fix: bind these
commands to the focused reader component, or remove the character aliases;
respect composition, prevented events and the overlay owner.

acceptance: keys outside the reader and under another overlay cause no reader
action; any retained aliases work only in their documented focus scope, and
the visible controls remain keyboard reachable.

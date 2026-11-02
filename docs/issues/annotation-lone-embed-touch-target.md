# a lone-embed annotation is hard to empty by touch

origin: 2026-11-02 annotation emptying qualification, android emulator · area: web
annotation editor

an annotation whose only content is one resource embed can be emptied by touch
through one target: the 21 css px line under the 52 px embed row. a tap on the embed
row, beside its controls or past its title, brings no keyboard and selects nothing;
a tap on the title follows its link. `clear annotation` was the other way out, and it
is gone.

impact: a thumb that lands on the embed row cannot remove it. the line under it is
below every touch-target guideline. hardware keyboards and pointers are unaffected.

evidence: emulator api 35, webview 124, gboard 14.2, case t2 in both green records:
removal by real touch and the real delete key worked from the line only. a lone embed
renders as a `div` and its node view's `stopEvent` blocks tap selection
(`NoteEditor.tsx`, `resource_embed` node view). handsets not observed.

proposed fix, already designed in the annotation emptying spec's contingent section: a
tap on an embed in an editable editor, away from its interactive content, selects it
as a `NodeSelection`; delete already removes a selected atom.

resolved when a tap on a lone embed's row, away from its links, lets the delete key
remove it on a phone.

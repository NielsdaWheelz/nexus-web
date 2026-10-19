# chat prose has a fragmented reading hierarchy

status: open
origin: 2026-10-16 chat viewer design audit
area: web / chat / typography

`apps/web/src/components/chat/ChatSurface.module.css:56-76` hard-codes message
size, leading and measure. `apps/web/src/components/ui/MarkdownMessage.module.css:1-12`
independently supplies those defaults through chat-specific properties that
have no setting owner. `:24-57` gives paragraphs and nested lists the same 16px
trailing margin; headings h2/h3/h4 use 15px/13px despite 16px body text. this is
source evidence for inconsistent ownership and hierarchy, not proof that any
particular font or spacing value is universally wrong.

impact: long answers have weak section hierarchy and disproportionately loose
nested material. adjusting one role does not establish a shared reading
contract. the live sample already used inter at 16px/25.28px; replacing the font
alone will not remove the structural footer gaps.

prerequisites: qualify the proposed reading rhythm with real short and long
messages. let chat own size, leading, measure and paragraph/list/heading rhythm
for both roles. preserve the shared renderer's other consumers, including
dossier abstracts; avoid selectors into another module's private dom.

acceptance: both roles share an explicit reading contract; section headings
remain recognizable, nested lists have compact grouping, and long answers read
comfortably at narrow and full pane widths. code, tables, citations and user
text-spacing overrides remain usable without whole-pane horizontal overflow.

# article canonical text can disagree with browser table parsing

the captured wikipedia “the book of the new sun” article publishes 17,507
canonical characters, but `buildDomTextCursor` over its sanitized html emits
17,505. the first character already differs: the api starts with the title;
browser-compatible parsing starts with the cover caption. the source contains
raw title text directly inside a table, which browser parsing reparents.

`apps/web/src/lib/documentReader/text/geometry.ts` correctly rejects a cursor
whose emitted text differs from its published canonical text. consequently,
marks and canonical selection are unavailable throughout this article. the
same qualification's nasa article agrees exactly (5,893 characters).

resolve at article sanitization/canonicalization: publish text from the same
valid html structure the browser renders, and republish affected generations.
prove resolution with the real table-containing article: identical canonical
text and provenance, painted saved marks and valid native selection.

# epub svg text hidden by presentation still counts

status: open
origin: 2026-10-21 ingest follow-ups review (finding 3)
area: reader python, epub sanitizer

canonical text counts the text the epub policy stores; the sanitizer drops svg text
that svg never draws by structure (`title`, `desc`, `metadata`, character data
outside `text`). svg text can still be invisible by presentation or drawn somewhere
other than where it sits:

- a kept presentation attribute hides it: `font-size="0"`, `opacity="0"`,
  `fill="none"` with no stroke (`_SVG_TEXT_ATTRS`, `python/nexus/services/sanitize_html.py`);
- it sits in content svg draws only by reference: `defs`, `symbol`, `clipPath`
  (drawn where a `use` points, in a shadow tree neither canonical text nor the
  reader's cursor walks, or used as a clip shape).

impact: such text is counted and highlightable but not seen; a highlight spanning it
stores words the reader did not show. offsets stay aligned (the reader's cursor
counts the same nodes), so no anchor drifts. no corpus book has either shape;
evidence is the review's three-engine run of `font-size="0"` text (2026-10-21).

proposed fix, if a real book needs it: drop `text` under `defs`, `symbol` and
`clipPath`, and drop the text of a `text` whose kept attributes make it invisible.
new ingests only.

resolved when such text is neither stored nor counted, or the owner accepts the
structural boundary and this file is deleted.

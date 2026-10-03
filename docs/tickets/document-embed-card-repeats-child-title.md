# document embed card repeats child title

status: open
origin: 2026-10-03, embed presentation session at 19af940d35a52e7e642f6b605737861ebe7fbb85
area: reader / document embeds

`services/document_embeds.py:590` uses the resolved target title as the default
display description. `documentEmbeds.ts:603–610` renders the target title,
then appends every nonempty display description. the actual settled browser
receipt `/tmp/nexus-pending-embed-settled-browser-receipt.json` shows
`YouTube Video PndEmbed001` in two adjacent description paragraphs.

this repeats visible child metadata; it is separate from the intentionally
retained canonical source caption.

prerequisite: preserve the canonical caption, authored detail and card actions.
fix the shared card projection to render the primary child title once and append
detail only when it differs. acceptance: resolved child title appears once;
pending/authored detail, actions and immutable source caption remain intact.

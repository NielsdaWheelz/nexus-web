status: open
origin: 2026-09-14 bounded reader review
area: pending source activation / payload admission

`pulseEvent.ts` retains an original citation locator before a destination reader
session exists. `DocumentReaderSession.sourceRange` charges that locator only
after admission. capacity refusal leaves the full input in the map after its
originating message can retire.

reader-selection snapshots bound exact text to 20,000 codepoints and each affix
to 1,000 (`schemas/chat_reader_selection.py`). retrieval quote selectors are an
unbounded dictionary (`schemas/retrieval.py`); the shared TS locator decoder has
no text length bound. no existing owner accounts for the pending map's retained
payload. this is ordinary source ownership, not hostile local mutation.

use the existing account payload admission owner for this specific pending
input before workspace activation. preserve one exact pane/media delivery and
its retry. keep the account charge until all delivery consumers retire; the
selected session also charges its own view budget. no charge transfer. an
unadmitted oversized input cannot remain strongly retained by the map. settle
actual close/navigation/supersession through its existing withdrawal owner.

acceptance: a held pre-mount delivery stays charged after its origin retires;
admission refusal handles the link and shows caller-local feedback without a
new quote or retry closure; the original source reference remains its retry;
replacement and close return occupancy to its prior value; exact full quote
verification remains unchanged.

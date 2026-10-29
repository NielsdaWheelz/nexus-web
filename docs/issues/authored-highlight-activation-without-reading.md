# authored highlight activation without a reading

source-confirmed contract mismatch after highlight excerpts, not reproduced in a
live consumer. `apps/web/src/lib/notes/presentation.ts:60` gives a highlight no
activation when `readingRef` is null; `lib/resources/localResource.ts:19` can
still derive its source route. consumers can therefore disagree about whether
the same canonical highlight is openable. lack of an admitted reading may be an
intentional refusal; deriving a route alone does not establish reading authority.

the palette preserves its selected primary target in its independent options
menu. other consumers need an owner decision: distinguish an admitted reading
from a syntactically available source route, then make the item and navigation
contracts agree. verify a direct local highlight reference with and without an
admitted reading; its visible primary and menu must share the same availability,
reason and target. do not add a route fallback to bypass scope admission.

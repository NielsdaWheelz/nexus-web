# a source link's accessible name differs from its visible title

source finding: `apps/web/src/components/resources/ResourceOutlineRow.tsx`
paints an unplaced highlight's `sourceTitle` as the link text, but passes the
quote as `PrimaryLink`'s `label`. `PrimaryLink` derives `aria-label="open …"`
from that label (lines 151–156, 242). the remote-passage variant follows the
same pattern (lines 183–184).

impact: speech-input and screen-reader users encounter a name that omits the
visible source title; the quote describes the passage, not the link target.

resolved when: the source link's accessible name includes its visible title,
with passage context supplied separately where useful.

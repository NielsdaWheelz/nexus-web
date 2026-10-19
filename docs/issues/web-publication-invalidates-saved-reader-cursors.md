# ordinary web replacement invalidates saved positions

ordinary web refresh/recapture replaces fragment ids without remapping saved
positions. `services/web_article.py:204` invokes the cursor owner only when
the previous or replacement source contains x embeds (`remap_x`). ordinary
articles without x embeds still skip correspondence before replacement.

the 2026-09-15 restored-data audit found one stale cursor among 206 web media.
the user deliberately reset that item's position; the general publication
defect remains. the x thread change now reconciles native x and ordinary
wrappers containing x, including exact parent positions and explicit unresolved
passages. its real api/browser qualification preserved the article's own
highlight and cursor during a canonical child edit.

extend exact correspondence at the ordinary publication owner. retain the old
excerpt when absent or ambiguous, preserve engagement/completion history, and
require deliberate adoption. resolved when ordinary refresh and browser
recapture preserve exact positions or expose unresolved recovery under
concurrent revision guards.

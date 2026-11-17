# a fresh show scrolls during initial publication

at `41c99d124`, lab `20261117-143038-8a8c18f30cf1` recorded a fresh NPR
Politics pane moving from `scrollTop=0` at 220555ms to 29 at 220710ms before
any reader input. the grouped-count chromium trace retains both snapshots;
firefox also reached 29. the width was already 611, excluding the helper's
separator drag. the name becomes clipped and the header title correctly returns.

impact: a direct open can crop the title page before the reader scrolls.
the trace shows the checks line appearing above the episode list, with header
and collation unchanged. `captureEyeLine` selects an episode below the title page
even at zero; refresh restoration preserves that episode by scrolling the pane.
the fix makes absolute top outrank row identity at zero. live proof is pending.

resolved when a fresh populated show's initial publication preserves its top,
while live DOM-list retention and scrolled/windowed back still preserve place.

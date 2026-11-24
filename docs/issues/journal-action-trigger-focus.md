# scrolling past today's actions can drop trigger focus

at `9aff45f4b`, `JournalPaneBody.tsx` keeps an open day menu mounted, but
a focused closed trigger does not retain its presentation. `JournalBandMenu`
returns null when the band leaves the viewport and its menu is closed. the
day article makes the reverse switch as the band reappears. this was also
identified in the private journal refactor source review.

focus the band action trigger without opening it and scroll until the band
leaves view. repeat from the article trigger while scrolling back to the band.
verify actual focus. resolved when yielding between these placements preserves
a usable focus target without keeping an offscreen editor attached.

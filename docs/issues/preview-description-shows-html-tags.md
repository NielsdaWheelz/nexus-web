# podcast preview displays raw html tags

at `b1a360ba4`, real podcast-index discovery for “the history of rome” opens
“ad-free history of rome patreon” with literal `<p>` / `</p>` in its description.
player qualification run `20261021-204721-b82aeead09ad`, volume journey's
`final.png`, shows the source markup as prose above the actual play-preview
control. this is outside the persistent-player change.

normalize provider description content at its existing text boundary; do not
render unsanitized provider html. resolved when the real preview shows readable
paragraph text without tags and preserves its links/content policy.

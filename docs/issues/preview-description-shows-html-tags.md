# podcast descriptions display raw html tags

at `b1a360ba4`, real podcast-index discovery for “the history of rome” opens
“ad-free history of rome patreon” with literal `<p>` / `</p>` in its description.
player qualification run `20261021-204721-b82aeead09ad`, volume journey's
`final.png`, shows the source markup as prose above the actual play-preview
control. this is outside the persistent-player change.

also observed on `ffcb3a4af` in the acquired episode's show notes during real
dropdown run `20261022-163215-d0abdcb80545`: econtalk's “lives wasted and
well-lived” description displays literal paragraph tags.
`python/nexus/services/podcasts/episode_acquisition.py` assigns the directory
description to `EpisodeFacts.description_text`; the text fallback in web
`app/(authenticated)/media/[id]/Transcript.tsx:113-125` correctly escapes it.
the provider text boundary still admits markup as plain text.

normalize provider description content at its existing text boundary; do not
render unsanitized provider html. resolved when the real preview and acquired
episode show readable paragraph text without tags and preserve their content
policies.

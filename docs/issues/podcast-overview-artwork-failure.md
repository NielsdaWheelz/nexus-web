# podcast overview has no failed-artwork presentation

the overview renders initials when artwork is absent, but a failed non-null
image never reaches that presentation. an expired url, rejected image or network
failure can leave an empty/broken image instead of the intended placeholder.
this is a source-derived gap, not a live reproduced browser failure.

evidence: `apps/web/src/components/podcasts/PodcastOverview.tsx:40-48` chooses
the placeholder only for `image.kind === "Absent"`.
`apps/web/src/components/ui/MediaImage.tsx:16-32` supplies image delivery and
forwards props but defines no failure presentation; the overview passes no
`onError`. `python/nexus/services/image_validation.py:73-82` can reject fetches
and invalid image data rather than return substitute artwork.

resolved when absent and failed artwork retain an intentional same-size
placeholder, and a changed valid source can load after an earlier failure.
verify null, failed and recovered sources in the show overview and browse
preview. keep failure presentation with the artwork component, separate from
generic image transport.

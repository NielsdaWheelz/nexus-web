# podcast relationship has two names

the same relationship is called followed and subscribed in one product.

evidence: `PodcastsPaneBody.tsx:176` "no followed podcasts yet.", `:206` "Filter
followed podcasts", `:281` `ariaLabel="Followed podcasts"`.
`LibraryPodcastsSection.tsx:51` `ariaLabel="subscribed podcasts"`, and every action
says Subscribe or Unsubscribe.

impact: a reader, or a screen reader, has to learn that the two words mean one thing.

proposed fix: pick one word for all user-facing copy. subscribed matches the
commands; followed is shorter. this is the owner's call.

resolved when `rg -i followed` over user-facing podcast copy matches the chosen word
only, or the owner keeps both and this file is deleted.

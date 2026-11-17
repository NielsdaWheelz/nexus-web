# podcast relationship has two names

the same relationship is called followed and subscribed in one product.

evidence (at `839bb918b`; the files this record first cited, `PodcastsPaneBody.tsx`
and `LibraryPodcastsSection.tsx`, no longer exist):
- `apps/web/src/components/feeds/FeedsPaneBody.tsx:241` ``ariaLabel={`Followed ${noun}`}``
  (and the file comment at `:3`, "The followed sources").
- `apps/web/src/components/feeds/LibraryFeedsSection.tsx:49` ``ariaLabel={`subscribed ${noun}`}``.
- `apps/web/src/components/feeds/FeedDetailPaneBody.tsx:407,412` `Library Subscriptions`
  and `ariaLabel="subscription libraries"`.
- every action says Subscribe or Unsubscribe; the stop review says `unsubscribe in {name}?`.

impact: a reader, or a screen reader, has to learn that the two words mean one thing.

proposed fix: pick one word for all user-facing copy. subscribed matches the
commands and the face-out direction sheet's libraries line (`subscribed in …`);
followed is shorter. this is the owner's call.

resolved when `rg -i followed` over user-facing podcast copy matches the chosen word
only, or the owner keeps both and this file is deleted.

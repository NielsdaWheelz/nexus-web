# privacy copy promises absent chat disclosures

the privacy page says chat shows processor, retention, training and billing
disclosures before dispatch. chat renders none of these facts; the generation
controls cut also removes its former routine billing subtitle.

source evidence at `6d6a6799c`: `apps/web/src/app/privacy/page.tsx:67-68` makes the
claim; `components/chat/GenerationPicker.tsx:49-57` supplies only billing detail.
searching `apps/web/src` for `processor_chain` and privacy field consumers finds
no rendering consumer outside generated wire declarations. the current
`GenerationPicker.tsx` supplies `detail: null`; the public claim at
`apps/web/src/app/privacy/page.tsx:67-68` is unchanged. disclosure behavior itself
has not been verified through a runtime journey.

impact: product copy describes an interaction the current interface does not
provide. choose the intended disclosure surface or correct the claim to match
actual behavior; this is independent of removing provider subtitles.

resolved when the public description and rendered chat behavior agree for both
codex and configured api routes, verified through an actual user journey.

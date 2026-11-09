# stock firefox headless playback qualification

the private stock-firefox playback check did not advance the media clock before
backgrounding. this is an unqualified browser/fixture path, not an established
product defect. actual background playback and job completion must be reported
with the browser in which they were observed.

evidence: isolated run `20261109-143538-0d60c6ef7ef3`,
`apps/web/.nexus-lab/cases/background-observation.spec.ts`; the normal play control
was activated, but `audio[aria-label="Media player audio"].currentTime > .2`
timed out after 15 seconds. the fixture was 90 seconds of pcm silence served by
an owned https endpoint, with its certificate imported into a private nss profile.
the same enclosure advanced its clock in pinned chromium. no background
transition was reached in the firefox attempt.

resolve by diagnosing the fixture's tls/media prerequisites and observing normal
stock-firefox playback through a real trusted visibility transition, or by
establishing the exact headless platform limitation. preserve production playback
and certificate policy; do not infer ordinary firefox playback failure from this
headless timeout. private diagnostics remain under
`/Users/nnandal/Documents/code/nexus-finite-observation/.nexus-local/lab/20261109-143538-0d60c6ef7ef3/`.

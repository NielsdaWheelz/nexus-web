# mobile passage composer device qualification

the paired android app passed the passage journey at `262adaf87`, but native
chrome qualification is blocked by the disposable api 34 image's chrome 113.
its real `typeof SharedWorker` is `undefined`; the browser authored store needs
that capability. do not enable an experimental flag or substitute a storage path.

evidence: lab `20261104-234933-0a9036986874`, private
`artifacts/mobile-passage-android/chrome-capabilities.json`. the android app step
completed native handles, ime/newline, first-tap exact save, saved annotation
save/reload and composed-writing discard protection. the following chrome
capability assertion failed; this is not a full native qualification pass.

resolve with a current stock chrome package on an owned disposable device, then
real login, passage handles, keyboard input, chooser and exact save through the
browser authored store. deploy the android apk paired with the final web revision
through the existing release owner; a previous apk's result is not that proof.

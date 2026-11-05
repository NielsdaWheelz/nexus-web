# native plain retry identity remains source-supported

`apps/web/src/app/share/ShareCapture.tsx` retains the authored capture handle, original date/id and text for ordinary retry; native capture metadata belongs to `ShareActivity.kt`. this implements the immutable retry contract, not a newly minted save.

first-save and automatic plain positive controls do not observe a genuine local save/check failure followed by retry. that failure path remains unobserved on native; neighboring url replay does not supply it.

resolve with a reviewed real local-failure boundary and ordinary retry producing the same immutable command and one matching local/public result. do not alter clocks or fabricate store replies. retain this source-only limit explicitly; it is not an accepted release waiver.

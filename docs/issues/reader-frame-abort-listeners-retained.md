# reader frame abort listeners survive completed frames

`apps/web/src/lib/documentReader/scrollport.ts:291-299` adds an abort listener for
each `nextFrame` call but removes it only when its signal is eventually aborted.
successful multi-frame positioning retains completed callbacks on the request
signal. this is outside the navigation-feedback cutover; no observed user-facing
failure is attributed to it.

remove the listener when the animation frame completes, retaining immediate
abort settlement. resolved when repeated successful frames leave no completed
callbacks attached and cancellation still settles the pending frame.

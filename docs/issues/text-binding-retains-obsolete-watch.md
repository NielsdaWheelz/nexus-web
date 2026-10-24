# text binding retains an obsolete resource watch

`apps/web/src/lib/notes/texts.ts:543-559` remaps a requested note ref to its
canonical ref in `texts` and `aliases`, but leaves any existing `watches` entry
bound to the requested ref. `journal.ts:620-626` publishes these bindings;
`:676-681` also publishes one when an observed draft changes its resource ref.

impact: if the requested ref already has a watch, a later unavailable result for
that ref can call `setGone(from_ref)`, whose alias lookup reaches canonical text
(`texts.ts:91-92,456`). a canonical note could therefore be marked unavailable
by its obsolete identity. source evidence only; whether a live binding can retain
such a watch still needs reproduction.

reproduce a requested-to-canonical note binding with an existing requested-ref
watch, then probe/read the old ref as unavailable. confirm the canonical note's
state and watch ownership. if reachable, retire the old binding and establish its
canonical watch without changing the authored branch. resolved when the canonical
note remains available and only its current resource identity can retire it.

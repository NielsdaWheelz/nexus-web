# production build retains stale patched dependency

problem: the canonical web build preserves `.next`, allowing webpack's immutable
`node_modules` cache to retain code from before an installed dependency patch.
this can ship a bundle that contradicts the installed source and current commit.

evidence: at `eda0c445146d8491cd1c1622740cfe66837daef0`, the installed
`apps/web/node_modules/@dnd-kit/core/dist/core.esm.js:1445` registers window blur
cancellation from `8dd886075`. the production-served
`apps/web/.next/static/chunks/9936-c2a742ff49e9d640.js` pointer sensor omitted that
listener. disposable lab session `97277` passed its first nine browser journeys
but failed blur cancellation. the runtime was fully removed after exit 1.

fix: make `apps/web/package.json`'s canonical `build:next` discard generated
`.next` before building, so every production build consumes installed dependency
bytes. the disposable runtime must keep using that canonical build.

resolved when a fresh canonical production build includes the pointer sensor's
blur listener and the explicitly injected window-blur case retires the pending
sensor: no move from the cancelled press, then exactly one canonical move from
the fresh gesture. rerun remaining acceptance on that build. native os focus
delivery remains `NOT_RUN`; the injected event does not establish it.

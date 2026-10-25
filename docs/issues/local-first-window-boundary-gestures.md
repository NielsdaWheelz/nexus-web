# gestures at a bounded outline window edge

`LocalOutline.tsx` previously derived indent/join from `rows[index - 1]`, mistaking an unloaded predecessor at the window edge for no predecessor. forward delete was also swallowed by a backward-only join port.

implemented: gesture-time closed `positions/neighbors` lookup and point resource resolution, in both join directions. join captures the active editor's observed body/touch before lookup; it does not copy/delete newly unseen writing because of added lookup latency. indent retains unlink/add semantics.

pending mounted proof: a centered window's first visible note indents/joins its predecessor outside the viewport without loading a prefix. ignored `editor-window.spec.ts` creates the centered window through actual composer append and checks both gestures.

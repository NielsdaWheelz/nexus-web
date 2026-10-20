# native visible-window blur remains unqualified

problem: native window-blur cancellation has not been qualified while the
document remains visible. a failure at this boundary could leave a pending
sensor able to claim a later press's identity. native os focus loss is `NOT_RUN`
and has not been waived.

evidence: the software fix cancels pointer sensors on blur in all three dnd-kit
bundles. the canonical clean build was verified to use the installed patched
javascript. disposable run `20261020-012955-82870a88513a`, source
`8d330ca0b4e4a5e97fbc6f69dd51b1498bc8a6e9`, passed 41 cases, including both
collections' injected **UNTRUSTED** window-blur cases: a fresh trusted 2px move
was rejected, a 14px move activated, and exactly one canonical write persisted.
pane-strip release suppression also passed. these prove the software contract,
not native focus delivery.

resolved when both library and lectern pass this native sequence: press a row
below activation distance; move focus to another native window while the document
stays visible; release outside; refocus; start an independent press. verify that
2px cannot activate, 14px can, one intended move persists, and cancelled release
cannot navigate. observe actual window blur; injected events and tab hiding do
not close this gap.

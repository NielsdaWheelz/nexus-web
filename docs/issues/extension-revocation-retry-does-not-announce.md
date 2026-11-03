# extension revocation retry does not announce its new outcome

problem: the revocation Hold always receives attempt0. a deliberate retry may
change refused to unknown visually without announcing the new uncertainty;
repeated same-kind failures likewise have no new speech occurrence.

evidence at candidate90b6bc5: `apps/web/src/extension/popup.tsx:236` passes no
attempt; `components/feedback/stage.ts:224,321` suppresses already-spoken attempts
and renews only for changed attempt/weight. actual temporary Firefox green run
20261103-032824-66d565a1aa0b accessibility tree shows a standing unknown Hold
while polite status remains the earlier refusal. this differs from retaining
last speech after a row has correctly withdrawn.

fix at the existing revocation result owner: carry an attempt counter, advance
once per fenced classified failure settlement, and pass it to the existing Hold.
a kind-derived0/1 misses repeated refusals or unknowns. preserve constant Hold id,
exact credential fences, sticky uncertainty and the sole recovery action.

resolved when actual addon refused-to-unknown and repeated same-kind failures
each publish their current outcome once, with no repeated speech caused merely
by status reads. actual assistive-technology playback remains separately unrun.

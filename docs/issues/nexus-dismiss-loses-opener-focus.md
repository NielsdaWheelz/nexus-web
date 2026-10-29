# dismissing mobile nexus loses opener focus

problem: at 390px, opening nexus and pressing escape closes its task but focuses
the active pane landmark instead of the explicit nexus button opener. waiting
for the initial workspace heading focus does not prevent it.

evidence: untouched baseline `aac38e09a`, disposable run
`20261028-190924-cf95b5f1e9ce`, rapid and settled journeys both fail the opener
focus assertion. private `focus.json` records the active
`section[data-pane-focus-landmark="true"]` while the connected nexus button
remains available. the same settled journey fails on `da19e2959`, run
`20261028-190822-8f9c635ed420`. `components/nexus/Nexus.tsx:23` explicitly focuses
the button before `useNexusController.ts:541` captures it; the cause is not yet
established. this predates the mobile companion change.

impact: keyboard users lose their opening control and must traverse the pane
again. investigate the overlay return-focus and workspace focus-repair owners
together. resolved when rapid and settled open/escape journeys restore the live
nexus opener without scrolling or overriding a later deliberate interaction.

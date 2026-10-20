# combine the reader toolbar with the menu cutover

problem: reader toolbar pr #697 and the action-menu cutover are separate branches.
the toolbar feature commit `7720e1cda` still uses the retired `options` prop.
the shared popup prerequisite `7291e158b` and canonical-origin prerequisite
`983c1495b` are already imported into the menu branch; do not reimport the reader
feature merely to acquire either primitive repair.

integration: adapt only the reader menu source to `Immediate`, keyed by
`reader-sections:${ready.doc.identity}`, with the complete section options.
preserve the toolbar's full accessible title, native button trigger props/ref,
reader-owned title span and decorative 14px chevron. retain no compatibility prop.

resolved when the combined source passes the static gate and live reader checks
for complete titles/counts, keyboard/focus, enlarged text and narrow bounds,
including the approved resize-close-and-reopen behavior. prior open-on-resize
proof from the popup prerequisite does not establish the final contract.

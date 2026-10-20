# palette screen-reader qualification requires native accessibility access

the palette changes the combobox browsing and secondary-control focus contract.
real screen-reader qualification is required by the opening specification;
browser accessibility snapshots alone do not establish that behavior.

on 2026-10-20 this session's ApplicationServices `AXIsProcessTrusted()` returned
false. a read-only System Events request hung, and a bounded VoiceOver
`last phrase` request timed out after 12 seconds. the VoiceOver process started
by that probe was stopped; it was not running before the probe.

provide native accessibility/automation access, or perform the keyboard journey
with VoiceOver manually. verify query editing, result announcements, candidate
selection, the single selected secondary tab stop, options opening on released
space, and escape restoring query/selection/mode. delete this issue after that
observed qualification; do not infer success from static checks or aria markup.

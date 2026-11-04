# one late anchor shift has not been attributed

the private `geometry-green3` run, based on rebased `ed8c504f` with the candidate
window repair, recorded a late +21/-21px pair in native a5 trial 2. requested
travel and relative compensation completed, but the stricter sampled-anchor
check failed two samples. the observed row was stress highlight 57 (zero-based),
`highlight:1243606f-7e2d-41b1-8ea6-5ff1c736f980`: a five-line annotation with no
embed or linked note of its own. that does not identify which upstream box moved.

the original receipt kept only injection-adjacent frames, so it cannot attribute
this later movement. `geometry-a5-trace` repeats the preceding journeys with full
frame boxes, writes and mutation/resize events; its three trials are green. the
old case never reassigned `scrollBy`, so the separate wrapper-restoration defect
does not explain this observation. host load alone is not an explanation.

retain the original red and full-frame diagnostics when qualifying the combined
prepared-content/window revision; a green run cannot retroactively explain this
observation. resolved when a captured occurrence identifies and repairs the cause,
or demonstrates a sampling artifact with a positive painted-position control.

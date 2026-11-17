# nested note text sits high beside its control

source arithmetic, not a rendered case: `ResourceOutline.module.css` keeps
2px top padding on `.content` (`--outline-content-top`, larger for coarse
pointers) beside a 24px control, tuned for 21px note lines.
`OutlineEditorRow.module.css` instead pads the row by 2px on the block axis.
companion notes use 13px/1.35 (17.55px), putting their first-line centre about
1.225px above the control centre.

impact: nested text and controls can look misaligned. nested gutters and row
geometry were outside the companion-density change.

resolved when: the row owner centres fine/coarse first lines at normal and
companion type without changing target minima or nested gutters.

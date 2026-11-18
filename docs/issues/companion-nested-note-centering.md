# nested note and resource controls have independent first-line geometry

`ResourceOutline.module.css` applies `--outline-content-top` beside a resource
control with a 24px fine or 44px coarse minimum. an embedded authored outline
now uses its margin role's 1.35 leading, 14px at the owner's profile, with zero
fine row padding. its own sign follows the line. the containing resource control
still has a separate baseline, so alignment cannot be inferred from row height.

measure the first text line against the containing resource control in a
column and sheet, at fine and coarse input. close when alignment holds at small
and capped profiles with the existing nested gutters and usable controls.

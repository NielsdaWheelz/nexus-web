# segment labels break mid-word in narrow tracks

`.segments` gives every option an equal `minmax(0, 1fr)` column and `.segment`
wraps with `overflow-wrap: anywhere` (`apps/web/src/components/ui/ChoiceField.module.css`).
when a track is narrower than its longest word needs, the word breaks inside
itself. the reader settings Focus mode group shows it first: in a 340px split
pane each segment is 69-74px wide and 43px tall, reading "Distracti/on-free",
"Paragrap/h" and "Sentenc/e" in every room; at 390px phone width
"Distraction/-free" breaks before its hyphen.

impact: legible but ragged labels whenever a four-option group shares a narrow
pane. no overflow or clipping. token-only changes do not help: tighter inline
padding still breaks "Paragrap/h", and `hyphens: auto` has no dictionary in the
lab's chromium, so it breaks "Paragra/ph".

a tested fix: `.segments { grid-auto-columns: minmax(min-content, 1fr); }` with
`.segment { overflow-wrap: break-word; }` breaks only at spaces and hyphens
("Distraction-/free"); a 320px track fits exactly (287 = 287), with columns
35/88/80/74 there and 85/90/85/85 at 390px. it gives up equal columns once
words cannot fit, and a 200% real zoom in a 320px pane may overflow (unverified).
equal `minmax(0, 1fr)` columns are part of the reader view contract, so this
waits for the owner's ruling between equal columns and whole words.

resolved when the owner has ruled and, under that ruling, Focus mode in a 320px
pane and at 390px either keeps whole words without horizontal overflow at 200%
zoom or the equal-column trade-off is written into the visual-system choice
controls section.

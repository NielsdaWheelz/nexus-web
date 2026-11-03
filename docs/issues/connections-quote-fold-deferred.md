# connections quote fold deferred

status: deferred by the owner, 2026-11-01. follow-up to companion density, which set companion
content type and row anatomy and left the fold out.

long quotes keep their full height in connections rows. the 627-codepoint fixture row stays
271px at 360px, and margin rows still run 1.5-1.75 times their passages.

evidence, firefox, 16px reader, css injected, cumulative on the density stack without
`clear annotation`: a resting quote of one line in `margin` and three in `all` moved mean row
77.8px to 59.9px, tallest 271px to 135px, whole rows 8.0 to 11.5, rows beside their passage
11 of 16 to 13 of 16, mean offset 19.6px to 8.2px. lab runs `20261101-203718-57dc246ea557` and
`20261101-210632-b85c8008765c`.

reason deferred: it adds interaction and code the density work doesn't need.

if reopened, these are settled:

- opening must move nothing. pushing neighbours moves targets during a press, which the
  annotation emptying design forbids and which kills an open `ActionMenu` through `stable()`.
  a quote lifted over its neighbours moves nothing.
- no `…`: fade the last line's end. a half-line peek leaks the next line's fill.
- clip with `overflow: clip`, since `hidden` makes a bfc that refuses the `⋯` float.
- a fold with no way to open it breaks `all` as a digest: reading then moves the text.
- it reverses #883's `no line clamp` and invariant 5, and it would bound the stub-to-quote swing
  that the connections scroll design accepts.

resolved when the owner decides to fold or closes this as not wanted.

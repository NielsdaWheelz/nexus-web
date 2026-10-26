# index scrolling uses guessed row heights

problem: the owner reports desktop flings repeatedly stopping after roughly ten
rows, including a small lectern and a podcast with about 200 episodes. the
shared index defers offscreen layout using geometry that differs from its rows.

evidence at `fa05d51f345d0eba831ed4d105597df070880263`:
`apps/web/src/components/ui/ResourceList.module.css:10-13` applies
`content-visibility: auto; contain-intrinsic-size: auto 52px` to every direct
list item, including sortable wrappers. `ResourceRow.module.css:14-35,47-51,86-95`
and current tokens imply roughly 61px ordinary rows at a 16px root font; narrow
stacked controls can require more. these are source calculations, not measured
heights. `CollectionView.tsx:217-220` mounts every received row. lectern is a
complete read; podcast pages contain 100 rows and continue without scrolling.

impact: provisional scroll extent can change as rows are laid out. this is a
shared candidate for the reported failure, not a proven explanation of its
ten-row cadence. the public web identity observed during investigation was
`c5cf4bc27a1f9838b630b177209e15c5bba87c99`; its list css is identical. installed
browser/session identity and runtime causation remain unverified.

the queue-index change removes that shared guessed-intrinsic-size policy.
ordinary finite lists use real layout; the 10,000-entry queue uses its own
measured compact-row window. neither establishes the cause of the reported
production fling failure; retain this record until that journey is reproduced.

the complete-index cutover additionally removes finite prefix loading and uses
native rows through 200, then actual measured uniform windows. local complete
extent/end checks through 10,000 pass; they do not identify the old production
ten-row cadence. the post-release reproduction below remains open.

resolution: reproduce after the release on a cold and settled desktop lectern
and podcast. capture loaded/dom row count, scroll height, frame stalls and
network timing during a fling; compare with only shared index containment
disabled. ordinary finite rows should have real geometry from first layout.
prove no artificial intermediate bottom, stable return position, and preserved
drag/focus at narrow widths and enlarged text. production reproduction was
unavailable during the owner's release; document-reader containment is separate.

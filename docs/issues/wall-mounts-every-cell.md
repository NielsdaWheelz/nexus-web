# the source wall mounts every cell

`CollectionView` renders the wall's entire intrinsic plan. the existing
`measuredIndexWindow.ts` geometry models uniform rows as index times height;
`paneReturnMemento.tsx` consumes that geometry and cannot represent grid columns.

impact: a wall above roughly 200 shows costs more mounted elements than rows.
this is sigla's accepted scope (2026-11-17); rows retain uniform windowing.

resolved when measured wall performance requires and validates a column-aware
geometry contract, including resize, return anchoring and removal focus.

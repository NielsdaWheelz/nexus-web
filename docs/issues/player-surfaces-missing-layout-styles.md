# player surfaces reference missing layout styles

problem: `GlobalPlayerSurfaces.tsx` uses `styles.column`, `styles.row` and
`styles.listening`, but `Player.module.css` defines none of them.

impact: identity, transport and stop controls receive no intended group layout;
sheet content can run together. this is source evidence, not a visual trial.

evidence: `apps/web/src/components/player/GlobalPlayerSurfaces.tsx:340,367,372,412,434,435`
references these classes. the complete `components/player/Player.module.css`
contains no corresponding selectors.

resolved when the player layout owner supplies or removes those references and
checks desktop bar and mobile expanded controls, including narrow widths.

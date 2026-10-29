# inline pane list integration

the standalone feature is qualified, but draft pr #860 conflicts with concurrent
palette changes on main `480c20a39`. the compact-palette branch/pr #859 already
carries the original immutable feature and focus fixes; merging the old
standalone tree would require reconciling its controller, presenters, rows, css
and navigation docs with the newer grammar.

the compact-palette owner has the final narrow `d9917f7bb` drop-target/copy fix,
`629c62c7f` android lab teardown fix and `d0b79fdc6` contract/follow-up handoff.
that carrier must preserve its current presentation while incorporating these
changes. standalone proof does not qualify the combined main implementation.

resolve when the integrated carrier includes these fixes and relevant contracts,
passes its static and affected live checks, and the duplicate standalone pr is
closed or reconciled. retain the original commits and local specification.

# add panel css build warning

status: open
origin: 2026-10-14 quick-read production-build qualification
area: nexus add / css

`apps/web/src/components/nexus/AddPanel.module.css:22` uses `align-items: start`.
the production build at `e1af653b2` succeeds but reports:
`autoprefixer: start value has mixed support, consider using flex-start instead`.
webpack then declines to serialize that module's warning into its build cache.
the rule is unchanged from `b6768bee2` and outside the lectern change.

prerequisite: confirm the add form's intended alignment in its flex context.
fix: use the supported alignment value at this css owner.
acceptance: the add form retains its alignment and a production build emits
neither this warning nor its associated cache serialization warning.

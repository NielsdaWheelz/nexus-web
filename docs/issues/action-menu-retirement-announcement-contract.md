# menu retirement's announcement contract disagrees with its implementation

`docs/modules/overlays.md:387-390` promises one announcement when changed
meaning or geometry retires a menu. `apps/web/src/components/ui/ActionMenu.tsx:316-319`
instead closes silently and explicitly describes that choice. observed by source
review at `41c99d124`; actual screen-reader output was not checked.

impact: consumers cannot rely on the documented feedback contract. establish
the intended dismissal behavior, then align the owner and its contract. resolved
when the same changing-reason journey has verified focus and speech behavior
matching the documentation.

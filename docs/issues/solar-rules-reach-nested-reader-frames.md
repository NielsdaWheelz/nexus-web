# solar rules reach nested reader frames

problem: in the Solar room a reader frame enters the Study or Press
(`apps/web/src/lib/documentReader/DocumentReader.tsx:289`), but Solar-only state
still reaches it. `color-scheme: dark` inherits (`apps/web/src/app/globals.css:222`).
the descendant rules `[data-theme="elvish"] ::-webkit-scrollbar-*` match inside
the frame (`:461-483`, fine pointer). firefox's `scrollbar-color` inherits from the
elvish root (`:492-494`), and `--gilt-*` inherits. `--ornament` inherits too, but
nothing in the frame consumes it yet.

impact: a light reader in the Solar shows brass scrollbars on chromium and a
dark-green track on firefox, and native widgets inside the frame use the dark
scheme. found by code reading; not rendered.

related: `press-and-study-leave-native-controls-on-the-ua-scheme.md` (the
`color-scheme` half; declaring it per room also stops this inheritance).

proposed fix: scope Solar-only descendant rules so they stop at a nested room
(e.g. `@scope ([data-theme="elvish"]) to ([data-theme]:not([data-theme="elvish"]))`,
browser support unverified), and have each room declare the tokens it relies on.

resolved when a light reader inside the Solar has Study scrollbars and native
controls in chromium and firefox.

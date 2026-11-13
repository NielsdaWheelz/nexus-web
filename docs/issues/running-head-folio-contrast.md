# running-head folio contrast

the specified faint folio ink is below 4.5:1 at its small text size on the light
reader page and in the press and study phone chrome. it can be hard to read.

source colours: `apps/web/src/lib/documentReader/documentReader.module.css`
defines light reader muted ink `#7a7468` on `#faf8f3` (4.37:1).
`apps/web/src/app/globals.css` defines press faint ink `#6f6f76` on
`--surface-2: #1c1c1f` (3.41:1) and study faint ink `#7a7a80` on
`--surface-2: #f4f4f0` (3.87:1). the phone control row uses `--surface-2`
in `apps/web/src/components/workspace/PaneShell.module.css`'s `.controlRow`.
ratios use srgb relative luminance. dark reader and solar pairs exceed 4.5:1.

the running-head direction explicitly requires faint folio ink. resolve by
approving muted ink for the folio, or revising the owning faint token palette.
resolved when small folio text reaches 4.5:1 in both page themes and all three
phone rooms, with the approved running-head hierarchy intact.

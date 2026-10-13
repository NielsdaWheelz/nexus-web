# launcher openable rows show a raw resource scheme

**problem**: the Nexus launcher labels an openable row's type with its resource scheme, so a
note block reads "note_block" (and any other multi-word scheme likewise). openables win the
launcher's dedupe over owned search, so the search projection's "note" label (fixed in the
search pane reauthor) never shows for a note block that is also an openable.

**impact**: cosmetic; the launcher's type column shows an internal name for note blocks.

**evidence**: `apps/web/src/lib/nexus/rows.ts:253` (`type: item.scheme`) for openable rows;
typing "wing clap" in the launcher over the search harness fixture shows
"Listen for the wing clap near the birches. note_block · …". the search harness journey
N3.launcher-type-labels withholds the note from openables to observe the search row's "note".
`lib/nexus/rows.ts` is outside the search pane slice's boundary.

**resolved when**: openable rows label their type in words ("note", not "note_block"), and N3
passes without withholding the note from the openables response.

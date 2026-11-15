# nexus says "no results." under rows it is showing

the phone palette still prints `no results.` in its notices whenever the local and
server searches return nothing, even while synchronous rows (panes, places,
commands, recent picks) are listed above it. typing `lib` lists six places and
commands and still says `no results.`. the notice also contradicts
[app-navigation](../modules/app-navigation.md), which says that with no
principals `search all results` is armed with `nothing matched here` and "no
separate empty notice is inserted".

impact: the notice denies the list the reader is looking at. low severity,
seen on every short query that names a place or command.

evidence, read at `8a16a039a`:

- `apps/web/src/lib/nexus/useNexusFind.ts:213-214` passes
  `count: localShown.length + preview.resources.length + preview.saved.length + preview.passages.length`.
  synchronous rows are not counted.
- `apps/web/src/lib/search/progress.ts:19,27,37` returns
  `{ kind: "Empty", text: "no results." }` when that count is zero.
- `apps/web/src/components/nexus/NexusRow.tsx:233` paints `Empty` as a fact.
- observed in a disposable lab on 2026-11-14 (chromium, press room): query
  `lib`, six rows, `no results.` beneath; query `zzqx`, no rows, the same
  notice under the continuations.

reproduce: open nexus on a phone, type `lib`, wait for searches to settle.

headword removes the desktop Empty notice. its name block owns
`nothing by that name.` after device and names settle. the shared progress
count and phone notice remain unchanged.

proposed fix: the palette, not the shared progress wording, owns its empty
state. either the controller withholds `Empty` while `list.rows` is non-empty,
or the palette drops the `Empty` fact and keeps the armed
`search all results` detail the doc already specifies. the search pane keeps
`no results.`.

resolved when phone `lib` shows no empty notice and `zzqx` shows exactly one
statement that nothing matched.

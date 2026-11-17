# scope by tab: a place or a work becomes a filter in the palette

status: deferred by the owner 2026-11-14 in the headword interview. not built.
direction sheet: https://claude.ai/artifact/NrP61YyH3wkVVFr6R5j5wX
("considered, and left out").

## what it is

a row that contains other things (a library, an author, a podcast, a work, a
place such as notes) can be entered as a scope. the row becomes a chip at the
head of the query, and what is typed after it is searched inside it:

```
⁂  ⟦ficciones⟧ labyrinth▏
```

- on a container row, ⇥ makes it the scope. backspace with the caret at the
  start of the text turns the chip back into selected text, so one more
  backspace deletes it and typing replaces it.
- inside one work, passages lead: you have said where, so content is no longer
  the noisy guess it is across the whole corpus.
- a place is both a destination (↵ opens it) and a scope (⇥ searches in it).
  this is what gives "categories first" a function beyond order.

## why

the owner's order puts categories first. as destinations they are already on the
rail; as scopes they would do something the rail cannot. github's palette (tab
adds the highlighted repo to the scope, backspace pops it), spotlight in macos
26 (an app or location name, tab, then the query) and linear's type prefixes
prove the gesture. it would also replace the browse-kind chooser page and the
`search people` pseudo-destination.

## what exists already

- the search grammar parses `kind:`, `format:`, `author:`, `role:` and `in:`
  tokens (`apps/web/src/lib/search/parseSearchInput.ts:2,16-19,52-67`).
- `settleSearchBox` already cuts typed operators into applied filters for the
  search pane (`parseSearchInput.ts:97`,
  `apps/web/src/app/(authenticated)/search/SearchControls.tsx:73`).
- the palette already parses the query through that grammar
  (`apps/web/src/lib/nexus/query.ts`, `parseNexusQuery`), and `plainSearch`
  in `rows.ts` already treats a filtered query differently.

so a scope is, mechanically, a row-to-operator map plus a chip drawn in the
query row.

## what is unknown or missing

1. **⇥ would mean two things.** on the headword page ⇥ opens the armed row's
   menu. scope by tab makes it "scope" on containers and "verbs" on leaves, with
   → as the constant way to verbs. the foot would have to say which, per row.
   this is the main reason it was deferred.
2. whether the preview endpoint accepts an empty text with a scope (browsing a
   container's names before typing). unverified.
3. which rows are containers, and which operator each maps to: library
   (`in:`), author (`author:`), a work (a media scope; no operator exists for a
   single work today afaict), a place (`kind:`).
4. the chip keeps part of the query outside the input's value. caret
   restoration, paste, and input-method composition all touch that seam.
5. the phone shares the engine and has no tab key.

## cost

moderate in the renderer (chip, backspace rule, foot wording), small in the
engine if items 2 and 3 resolve without a server change, larger if a per-work
scope needs one.

## resolved when

the owner takes it up or closes it. if built: ⇥ on a library row scopes the
palette to it, typing lists only that library's names, backspace at the start
restores the chip as text, ↵ on the same row still opens the library, and the
foot states which of the two ⇥ will do for the armed row.

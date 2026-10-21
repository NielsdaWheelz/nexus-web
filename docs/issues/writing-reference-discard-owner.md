# recovery discard leaves a retained raw-reference editor without a journal owner

`useReferenceInput.ts` keeps its opened handle but never subscribes to that branch.
notes recovery can discard the same owned raw-reference row. the retained pane
keeps the query; subsequent raw input paints, but `set` returns when `readDraft`
finds no row, leaving no checkpoint or exported authored draft.

real reproduction is the temporary browser case `discarding a retained raw
reference`: complete an offline query checkpoint, navigate to notes without a
reload, discard its recovery row, return through the same pane tab, and type a
new query. source repair must follow an actual red run. resolved when discard
returns to the preserved base body and new raw input gets a fresh durable branch
without remounting or a whole-journal subscription.

qualification note: the first raw-surface case stopped at invalid empty-create
setup (`400 E_EMPTY_NOTE_BODY`); it was not a raw-owner red. setup now creates a
nonempty note and clears it through the real editor. the owner repair shares the
already-proven obsolete-handle failure of the explicit resource composer.

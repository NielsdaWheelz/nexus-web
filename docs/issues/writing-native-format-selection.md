# formatting can miss an immediately preceding native selection

at `5eca855d4`, private run `20261021-125632-fe36feba9150`, three rich-writing
journeys failed before their transport/process fault: fill → select all → bold →
arrow right left no strong node. `NoteEditor.tsx` handled mod-a only for embeds,
so paragraphs depended on native selectionchange; `format` read the older
prosemirror selection without the native-selection synchronization already used
by structural commands. the mark could apply only to the stored caret marks.

handle select all inside the editor and synchronize native selection before
formatting/link commands. resolved when the unchanged rich conflict, successor
and process-restart cases reach their substantive fault with the exact strong
body durably checkpointed.

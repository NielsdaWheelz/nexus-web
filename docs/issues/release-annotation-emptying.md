# release annotation emptying

`clear annotation` is gone: deleting the text empties an annotation, and a blank
field takes the look of a never-annotated highlight once focus leaves it. web gets
this at the next web release. the apk owns interface delivery
([device startup](../modules/device-startup.md)) and packages `apps/web/src`, so an
installed app keeps the old button until its next build.

mixed versions are safe. the old button is an ordinary body edit, and nothing here
changes wire, schema, migration, command or projection; `X-Nexus-Wire` does not move.
stored empty code bodies stay as they are, and the next delete in that field repairs
them.

emulator evidence proves webview and its keyboard, not a handset's keyboard.

resolved when a released apk on a real handset shows no `clear annotation`, a real
delete key returns an empty code body to prose, and a tap away from an emptied field
reaches `annotate`.

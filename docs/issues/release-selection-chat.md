# selection chat release

ship api, web, extension and android artifacts together at wire revision 19; main
already bumped it after android-v0.3.10. no additional bump before that release.

stop writers, verify a database backup and migration ancestry, then apply the one
snapshot migration 0332 after 0331. it converts `{key,evidence}` to
`{evidence,highlight_ref}` and refuses unconvertible data. passage evidence,
accepted generation intents, retrievals and existing highlights are preserved.
no automatic historical-highlight cleanup is authorized.

the combined chat cut follows this with 0333 source citations and 0334 bounded
quote admission; use [the paired cutover](release-chat-send.md).

preflight: migration on a restored ordinary snapshot database; verify exact head,
unchanged evidence and prompt bytes, paired native wire, then resume writers.
qualify raw/highlight quotes and an exact live citation on each shipped client.

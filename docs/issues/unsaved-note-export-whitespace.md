# unsaved note export trims literal whitespace

`WritingRuntime.uncommittedText()` maps canonical bodies through
`projectBody(...).text` (`apps/web/src/lib/notes/runtime.ts:214`, owner blob
`9bfcf6de529cba69e19996e2c4c06a17c6b18e9c`). that search/inspection projection
strips leading and trailing whitespace and line endings. a failed code edit can
therefore lose significant whitespace through “copy unsaved note edits”.

the separate pending-outline export uses literal canonical text; it does not
repair the runtime export. this is source evidence, not a reproduced clipboard
failure. the runtime is a coordinated owner file and must not be changed locally
without its owner's review.

resolve by using the canonical grammar's literal text projection in the runtime
export. verify leading spaces, trailing spaces and final newlines from a real
failed save, independently of the normalized `body_text` projection.

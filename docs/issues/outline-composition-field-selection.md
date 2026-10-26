# delayed composition field-ownership journey is unqualified

run `20261026-064707-ccec71cf5778`, current-main plus `f50`, fails unchanged
`mobile-editor.spec.ts:784`. the semantic adapter ends one composition, moves a
dom range to an empty second field and starts another composition synchronously.
the first note durably contains `alphaX`; the second stays empty. the final
rendering shows `Q` in a new third note, so the trace does not establish lost
text. later query/history-focus phases are not reached.

the adapter collapses a range at the end of the field div, outside its empty
paragraph. this does not establish a valid inline caret; the input owner accepts
inline positions. requalify the same synchronous transition with a caret inside
the empty paragraph and an explicit native selection assertion before typing.
do not change production from this malformed premise. no physical ime behavior
is qualified by this case.

trace: that run's `mobile-editor-older-compos-98d97-ir-original-field-ownership`.
resolve with a verified field-local selection premise, unchanged exact canonical
field identities/text and later query/history-focus oracles. fix the owning
input boundary only if a valid native input is misrouted; do not add a delay.

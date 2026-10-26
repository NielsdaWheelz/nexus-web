# repeated quick-note entry after filtering has no append field

run `20261026-064055-9eb83ba22c1b`, current-main plus `f50`, fails the unchanged
`mobile-editor.spec.ts:648`. public cold title/note edit commands focus correctly
and their canonical writes pass. quick note opens today; its filter accepts
`no matching entry`; repeating quick note clears the filter, but no trailing
field exists for the requested focus. later typing is not reached. the same
account has a 61-note daily page from an earlier passing absolute-tail case.

trace: that run's `mobile-editor-resource-edi-21f13-d-quick-note-reaches-append`.
the same page/session survives both commands. `append()` initially has no
admitted window and waits for its tail field. `tryFocus()` then returns on the
missing row before its existing missing-field branch can request the absolute
tail window. the eventual prefix contains 48 notes and a pagination gap. move
that existing navigation before the absent-row return, preserving its lease,
anchor guard and admission bounds. the source repair awaits live qualification;
no writing loss or capacity failure is established.

resolve by the same public repeated command clearing the filter, revealing and
focusing its bounded absolute-tail input, then persisting the exact new final
note while preserving previous notes and order.

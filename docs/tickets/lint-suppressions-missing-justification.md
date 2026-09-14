# three lint suppressions still omit the repository-standard justification token

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: overrides / cleanliness

## what is wrong

`docs/rules/overrides.md` requires every suppression to carry its
`justify-eslint-override` token and the invariant it protects. one of the four
suppressions this cutover added was repaired
(`apps/web/src/lib/reader/useReaderProgress.ts:782`, which also removed the
durability hazard the rule was guarding rather than documenting it). three remain:

- `apps/web/src/components/ui/MediaImage.tsx:84`
- `apps/web/src/components/reader/ReaderTableCapacity.browser.test.tsx:55`
- `apps/web/src/lib/media/ArtworkCapacity.browser.test.tsx:97`

## prerequisites

none. for each, state the invariant that makes the suppression safe, or remove
the suppression by fixing the code — the first suppression in this list was
removable that way.

## proposed fix

add the token and the invariant, or delete the suppression.

## acceptance

no suppression in `apps/web` lacks its justification token.

# the editor's name key lowercases where the server casefolds

status: open · origin: 2026-10-10 authors reauthor (cleanup/authors-reauthor), spec §6 defect 5 residual · area: contributors / web editor

`lib/contributors/credits.ts` `contributorNameKey` applies NFKC, drops
`\p{Default_Ignorable_Code_Point}`, lowercases and collapses whitespace. the
server's `contributor_taxonomy.contributor_match_key` casefolds (NFKC_Casefold).
`toLowerCase` differs from full casefolding for ß/ẞ, ligatures such as ﬁ, and the
final sigma, so "Straße" and "STRASSE" are different keys in the editor and one
key on the server.

impact: the editor offers "Create “STRASSE”" next to a new row "Straße" instead
of "Already added". saving both creates two distinct people credited on one work.
the server decides identity, so nothing merges silently; the cost is a duplicate
person the user asked for twice. whitespace and default-ignorable variants are
already caught (harness X5).

fix: casefold in the browser (a small casefold table for the characters whose
lowercase differs from their full casefold, or a `String.prototype.toLocaleLowerCase`
replacement), or have the server return the name key with each search result and
compare keys from one owner.

acceptance: with a new row "Straße", typing "STRASSE" shows Create disabled
"Already added" and "Create a different author with this name" enabled.

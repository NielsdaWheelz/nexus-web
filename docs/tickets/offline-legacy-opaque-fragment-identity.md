status: open
origin: 2026-09-13 bounded workspace migration review
area: offline publication identity

`OfflineReaderDocumentVerifier.verifyWeb` accepts nonblank fragment ids up to
256 code points; the shared valid schema-1 corpus includes non-UUID ids.
`reader_publication.py` and the schema-2 consumers currently require UUID
fragment ids. minting replacements would invalidate stored progress/highlights;
rejecting them would strand supported installed packages.

make the publication wire preserve the existing opaque fragment identifier.
keep backend UUID storage/type validation at its own producer/query boundary;
local member filenames can use ordinals. no alias identity or legacy wire fork.

acceptance: an actual valid old non-UUID package converts and opens offline
with identical generation, original fragment locator, cursor revision and
pending intent id; hosted UUID publications retain their strict SQL boundary.

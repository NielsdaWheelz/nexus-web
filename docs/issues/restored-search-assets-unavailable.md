# restored-reader asset errors

browser126 records134 non-search500 responses from `/media/{id}/assets/{path}`,
mapped to `E_STORAGE_ERROR`. the source owner classifies storage failures as
missing or unreadable; these logs do not distinguish absence, permissions or
transport. the isolated storage does not establish availability of restored
source objects.

impact: text activation passes, but complete restored-reader rendering and
representative ordinary traffic remain unqualified. private evidence:
`.nexus-local/search-qualification/runtime126-client/api-diagnostic.private.log`.
resolve by supplying the required owned assets through the existing storage
contract and checking the reader, or explicitly limiting the qualification claim
to text with this failing traffic retained. do not rewrite source urls or mask
storage errors to obtain a pass.

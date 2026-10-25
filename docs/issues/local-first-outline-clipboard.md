# local outline block clipboard

`LocalOutline.tsx` implements relationship drag data but omits the old `OutlineSurface.tsx` block copy/cut/paste handlers. copied notes must clone canonical words, marks and embedded refs into independent notes; copied resource references must link existing resources. cut must unlink observed relationships without deleting notes. nested copied parents must remain explicit.

restore this behavior at the local outline selection/history owner with atomic paste commands. resolved by mounted copy/cut/paste cases that preserve content, nesting and independent identities without old writing endpoints.

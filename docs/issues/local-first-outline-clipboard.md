# local outline block clipboard

`LocalOutline.tsx` implements relationship drag data but omits the old `OutlineSurface.tsx` block copy/cut/paste handlers. copied notes must clone canonical words, marks and embedded refs into independent notes; copied resource references must link existing resources. cut must unlink observed relationships without deleting notes. nested copied parents must remain explicit.

restore this behavior at the local outline selection/history owner with atomic paste commands. resolved by mounted copy/cut/paste cases that preserve content, nesting and independent identities without old writing endpoints.

qualification red: `efe55fb40`, run `20261025-143634-d4183b8b165b`.
copy/paste preserved marks and minted an independent note, but cutting that note's
centered link left zero visible rows. the window query required a live anchor;
cutting it made the position comparison null and hid the surviving sibling.
`node/authored/src/queries.ts` now retains a removed link's position only for
window location; returned neighbors and structural lookup still require live
membership. the real-store regression passes; mounted qualification remains.

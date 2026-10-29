# reported authors index needs an exact identity

the owner confirms that the authors index resource and empty people search are
different destinations. `614ebd3e4` names the latter `search people`, retains
`authors and contributors`, and preserves resource-owned activations. a real
same-title authored page and the filtered people search were verified separately
on `e6f6dc9d4`; this does not identify the owner's personal index.

the reported index's canonical ref/href remains unobserved. no standalone authors
index route exists in this checkout; do not infer identity from its title or add
a route. obtain the actual resource ref and landing from the owner's workspace,
then verify its retained target alongside `/search?kinds=people`. that observation
closes this reproduction gap; the shortcut-copy defect is resolved.

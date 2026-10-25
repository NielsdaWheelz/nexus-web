# note-owned passage activation is discarded

source review at `d7350208` finds that
`python/nexus/services/resource_items/routing.py:_dynamic_routes` builds note-owned
chunk/span routes from `locations.current_passages`, but
`resource_activations_for_refs` then removes them: its canonical-scheme branch
discards a route whenever the ref is absent from `media_passages`. that resolver
returns media owners only. readable note passages can therefore have a `none`
activation even when their current locator lands.

`docs/modules/resource-references.md` requires passage routing to agree with
current capture/location proof; `locations.current_passages` explicitly supports
note owners. this is a structural finding, not a reproduced browser failure.
the presentation performance repair preserves existing output rather than
silently changing this separate behavior.

resolved when a visible current note-owned chunk/span keeps its canonical note
route, while missing, hidden and unlocated passages remain unavailable, verified
through the public item/activation contract. preserve note-owned passage-anchor
routes as well.

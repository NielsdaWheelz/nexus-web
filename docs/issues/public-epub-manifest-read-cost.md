# large public epub shares rebuild their manifest on each read

the exact norton epub with 1,400 proved note bodies took 7.3–11.7 seconds
for a public document read and 4.6–5.0 seconds for a successful note or
asset read in disposable run `20261123-202809-495aaa1e7079`. the requests
succeeded, but this is slow for an ordinary reader interaction.

`python/nexus/services/public_resource_sharing.py` rebuilds the document and
authorized manifest before each ordinal lookup. intra-request anchor reuse
bounds repeated fragment parsing. whole-manifest work still recurs across
requests.

resolve by qualifying the cost of document, note and image reads on this
edition with the same grants. cheaper discovery of an unchanged manifest must
still reject stale ordinals after note, asset or authorization changes.

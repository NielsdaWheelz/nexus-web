# full epub note requests miss the response target

all 16 measured full-note requests on native `8e22d112` exceeded the 250 ms
server budget. they took 254–707 ms across first reads, repeat reads and reads
alongside search. the receipts are `epub-native-20261124/lean{448,416}/latency.log`
in private nexus state on macbook.

close when those requests meet 250 ms while preserving the complete note,
its source and actions.

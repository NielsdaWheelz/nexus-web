# keyword search is slow during publishing and reader use

keyword search exceeded its 1 s server budget on three of six requests in the
native `8e22d112` rehearsal, reaching 2.684 s. the searches ran alongside
publishing and full-note reads. the receipts are
`epub-native-20261124/lean{448,416}/latency.log` in private nexus state on macbook.

close when the same overlapping keyword searches meet 1 s with matching results.

# epub reading-copy speed needs production-like storage measurements

alter's reading copy took 9.859–12.480 s against a 4 s server budget in the
native `8e22d112` rehearsal. the test read 31 assets through a remote relay.
production object storage timing is unknown. the receipts are
`epub-native-20261124/lean{448,416}/latency.log` in private nexus state on macbook.

measure first and repeat requests with production-like storage latency.
close when both meet 4 s and the resulting copy preserves its contents and
saved reading state.

# opening alter's reader exceeds the response target

in the native `8e22d112` rehearsal, the reader request took 3.019–3.456 s
on first and repeat opens at 448 and 416 mib, against a 3 s server budget.
the receipts are `epub-native-20261124/lean{448,416}/latency.log` in private
nexus state on macbook. close when both opens meet 3 s while returning the
same reader contents and restoring the saved place.

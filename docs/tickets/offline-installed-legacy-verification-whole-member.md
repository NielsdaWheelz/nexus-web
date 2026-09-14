status: open
origin: 2026-09-13 bounded-workspace implementation
area: native offline conversion

the previous installed-package verifier decoded the complete schema-1 reader
before conversion. that branch is retired: current installed verification
hashes the original members, and the streaming converter validates source
before schema-2 activation. the exact 64 mib encoded source profile is canonical
green `9e65cb29ca5735e0`: direct conversion/preparation preserved source and
produced 512 units; sampled host heap peaked at 345,894,256 bytes, linux hwm
775,100 kib including the test framework. it took 64.386 seconds. this is not
a cold-store/device capacity qualification.

prerequisite: retain the implemented bounded source/tree staging and existing
source acceptance contract. qualify cold store reconciliation and actual device
capacity; do not restore the old decoder or delete an original on resource
failure.

acceptance: cold reconciliation of the maximum installed member remains within
the qualified native budget, converts offline, preserves exact locators and
pending intent, and retains the original on interruption/failure.

# online backup overlap exhausted the component budget

status: open; actual memory failure, incomplete process attribution.

source `7173b6a91`, run `mac-search-7173b6a91-1b9ec08d05a6`, recorded oom 1/kill 1
in its 1280 mib/no-swap parent during backup and mixed work. strict-scan job
`01a1875b-80ca-7de0-8444-d043ea72881c` settled DEAD attempt 1 with
`E_RESOURCE_LIMIT` and one child observation; no budget or failed row was reset.
postgres kept its epoch and 512 mib leaf; conservative peak 444350464 bytes was
below its 448 mib conservative-use ceiling. these near-event samples correlate
demand; they are not an atomic additive parent total or kernel proof of the
killed pid.

| component | approximate concurrent charge, mib |
| --- | ---: |
| postgres | 415 |
| background | 295 |
| api | 223 |
| interactive | 154 |
| codex | 91 |
| backup | 81 |

backup then NATURALLY completed canonical create/full-byte verification:
1,550,876,445 bytes, sha256
`02870bf860eb012d6bf13a5bb388b20d948f41e78bf77d2c4d25f0b303ab5e96`;
maintenance exited 0. the earlier e8 run completed the functional flow through
final recheck but FAILED before backup creation on invalid naming. neither result
repairs the 1b memory verdict. auxiliary and runtime recovery-only cleanup are
confirmed. preparation-owned v4 cleanup also exited 0 with cleanup confirmed:
the prepared postgres, volume, network and parent are removed; the protected
original postgres and shared daemon were verified unchanged. before removal, a
private full database snapshot preserved 1,550,879,940 bytes, sha256
`8c5f061ac4acfb1e13364113abb2afa844a27ebfc8dd59d7e40dfd11eaa10ebb`.
the original failed verdict is unchanged. failed raw monitor/run receipts remain
private under
`.nexus-local/native-capacity-7173b6a91/oom-online-qualified-actual.private/`.

resolve by attributing memory ownership and proving a successful current-source
workload within a justified unchanged envelope, then the required
[actual 2 gib qualification](search-whole-host-qualification-environment.md).
this larger-host failure does not establish failure of a physical 2 gib topology:
the 1280 mib budget includes declared outside-system/connector/reserve deductions.
no silent budget increase, counter clearing or failed-job reset can produce a pass.

# production infrastructure swap limits differ from docker metadata

status: open; retained infrastructure no-swap check failed again · origin: 2026-10-14 release capacity audit · area: deployment / cgroups

at 05:41 and 06:10 utc, production postgres, caddy and codex-egress-policy
report `HostConfig.MemorySwap == HostConfig.Memory`, matching compose's
no-swap declaration, but their effective cgroup-v2 `memory.swap.max` is `max`.
postgres had about 160 mib swapped at the later sample. api, both workers and
native codex have effective swap max 0. no configuration was changed by that
audit. the recurrence below identifies the responsible runtime boundary.

evidence: release artifact `api-capacity-384-20261014/host-charge-snapshot.json`,
timestamp `2026-10-14T05:41:56.777005+00:00`; postgres container
`1e931e42456151730b9cf1646b5abe0df708a974cc9a47a73b90c0e272b413bc`.
capacity evidence must report the effective limits, rather than claim all
services run without swap from docker configuration alone. already-swapped
pages also cannot be counted as unused ram if those pages must return.

runtime correction: canonical deployment of `58c7ecae6` replaced postgres
after draining writers and verifying its r2 backup. canonical compose then
recreated only caddy and codex-egress-policy at 16:57 utc, with the same images,
caps and configuration. at 17:01:39 utc all seven owned containers had effective
`memory.swap.max=0`, `memory.swap.current=0`, and the declared memory caps.
canonical `release.py --check` passed after proxy recreation, including codex
isolation. no resize, reboot or live kernel-limit patch was used.

receipt: `current-role-kernel-limits-postproxy-20261014T170139Z.json`,
sha256 `5380f40544465d92ded21dde9046b483a8a1e14912882d6ceb3e5a74df299452`.

recurrence during the canonical `665e7b3af` deployment: all seven old cgroups
changed `memory.swap.max` from `0` to `max` between
`20:47:40.537273` and `20:47:41.537382` utc. their container identities, cgroup
inodes and memory caps did not change; selected docker memory/swap declarations
also remained equal. five services were subsequently recreated with effective
zero. retained caddy `65c070a4442d` and egress `3ac54e10e2f6`, both started at
16:57, retained `max`; caddy actually swapped pages. the earlier 17:01 zero
was therefore a real correction, not durable enforcement.

mechanism: `deploy/hetzner/release.py:343–353` unconditionally runs
`systemctl daemon-reload` while installing host inputs, before service
convergence (`:625–627`, `:511`). this matches the observed transition and
[upstream cgroups issue 74](https://github.com/opencontainers/cgroups/issues/74).
the installed runc reports `1.3.5`; its
[upstream tag](https://github.com/opencontainers/runc/blob/v1.3.5/go.mod#L16)
uses cgroups `v0.0.4`. its
[systemd driver](https://github.com/opencontainers/runc/blob/v1.3.5/vendor/github.com/opencontainers/cgroups/systemd/v2.go#L217-L224)
omits `MemorySwapMax` when the converted limit is zero, although the filesystem
driver sets `memory.swap.max=0`. systemd can then reapply its default infinity
on reload. upstream [fix 78](https://github.com/opencontainers/cgroups/pull/78)
was still open on 2026-10-14. no production reload was performed to reproduce it.

the 21:03:08 utc curated read confirms the missing persistent property:
both newly recreated proxy scopes have `MemorySwapMax=infinity` while their
kernel swap max/current are `0/0` and memory caps remain 48/64 mib. installed
versions: docker `29.5.2`, compose `5.1.4`, containerd `2.2.4`, runc `1.3.5`,
systemd `255.4-1ubuntu8.17`; systemd driver, cgroup v2.

2026-10-14 mitigation: root recreated only the two proxies through exact published
compose, after the final daemon reload. new caddy `89c38adb9b58` and egress
`a5a9a379ad72` started at 21:00:46 utc. the 21:02:22 observer gate proves all
seven roles again have effective swap max/current `0/0`, with other roles
unchanged. no further daemon reload was planned during that acceptance. scoped
recreation corrected that observation; it did not close this ticket.

evidence under the private campaign release directory:

- `capacity-2g-reaudit-20261014/repair-665-kernel-limit-transitions-20261014T205932Z.json`, sha256 `1f0182a3ec0625c40530395e8902337f793453efc38dc8523d3f755d9b215bc9`;
- `capacity-2g-reaudit-20261014/repair-665-postproxy-actual-limits-20261014T210221Z.json`, sha256 `a70cf51422218010113b30948dc9070f140c14288ff25cd87b626d5d585ed000`;
- `attempts/665e7b3af/swap-limit-diagnosis/versions-and-scope-properties-20261014T210308Z.json`, sha256 `ea4e80863bc405c5a980c6c2a33a3f38163e40f4323b9fa7cd4b9a6e80c46658`.

follow-up owner: the planned post-release deployer/runtime work. validate
effective owned memory/swap limits after host-input daemon reload and after
service start, including retained services. avoid unnecessary reloads for
unchanged host inputs, but do not mistake that for persistence across other
host maintenance. resolve the missing systemd scope property through a reviewed
runtime fix or scoped composition policy. infrastructure reconciliation must
retain the normal writer drain/backup lifecycle; no blanket scope drop-in,
live postgres kernel patch, or release-critical controller change was made.

closure: in an isolated rehearsal, the persistent owned parent has systemd
`MemorySwapMax=0` and kernel swap max/current `0/0` across daemon reload and
retained/recreated service starts. all seven actual process cgroups descend
from it, retain their declared memory caps and have zero swap usage; deployment
rejects a mismatch. record actual leaf limits separately: inherited zero is
effective even when a leaf reports `max`. then record healthy production limits
and the qualified whole-host memory margin.

2026-10-16: an owned ubuntu 24.04 vm with docker `29.5.2`, containerd `2.2.4`,
runc `1.3.5` and systemd `255.4-1ubuntu8.16` reproduced the unchanged container's
leaf swap limit changing from `0` to `max` on daemon reload; production systemd
is `.17`. the bounded source correction installs `system-nexus.slice` under
`system.slice`, assigns the seven services to it, and checks the persistent
parent, actual process ancestry, caps and swap usage after start and in
`release.py --check`. it adds no aggregate memory limit or unrelated host policy.
the actual controller proof, retained/recreated persistence and production
acceptance remain pending; this ticket stays open until that evidence exists.

2026-10-15 final release: `fdd0a3e` recreated the four application services
with effective swap max/current zero. retained postgres `ba34d07e18bd`, caddy
`89c38adb9b58` and egress `a5a9a379ad72` still had unlimited effective swap and
nonzero usage. the observer also caught the old application cgroups changing
from zero to unlimited between 21:42:05.529692 and 21:42:06.531145 utc during
host-input installation, before their replacement. this repeats the observed
reload boundary; no artificial production reproduction was performed.

actual postcandidate limits: private book-repair campaign
`coordinator/finalfdd0a3e/host-observer/postcandidate-actual-limits.json`,
sha256 `5c69c366ac3ac7a0ed7ea7ad05a5566bdbf97257ec06917e673056321b032caa`.
phone and provider checks passed with actual pressure recorded separately;
they do not establish whole-host no-swap capacity. this remains with the
deployer/runtime follow-up. no resize, reboot or live kernel patch was made.

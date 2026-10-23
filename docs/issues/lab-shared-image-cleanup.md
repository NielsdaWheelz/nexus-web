# lab cleanup counts other runs' images

`python/scripts/disposable_runtime.py:1334-1339` treats any host image matching
`nexus-lab-*` as this invocation's incomplete cleanup. concurrent labs therefore
leave private inputs behind and can turn a successful driver into exit 125 even
after their own containers, volumes, networks and process groups are gone.

observed in run `20261022-165251-1a999a86ada4` on base `ffcb3a4af`:
`cleanup incomplete: host-wide lab images remain`. its recorded groups were gone,
owned docker project/auth containers were absent, and api/web/tls ports closed.
other runs' images must not be deleted to satisfy this check.

scope image verification to this run's owned image names, matching the existing
project-scoped resource checks. resolved when overlapping labs both remove their
own private inputs and report their own driver verdict without touching peers.

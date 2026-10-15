# local docker default network pools are exhausted

status: open · origin: 2026-10-15 selection composer local qualification · area: local infrastructure

creating the task compose network returned `all predefined address pools have
been fully subnetted`. existing task networks occupy the default pools. no
network or volume was pruned. this task uses its own checked, explicit
`10.231.51.0/24` network instead.

prerequisite: coordinate with other local task owners. establish an explicit
local network allocation policy or retire only owner-confirmed unused networks.
preserve task volumes; no docker reset.

acceptance: new isolated task services can obtain a nonoverlapping network
without deleting another task's resources.

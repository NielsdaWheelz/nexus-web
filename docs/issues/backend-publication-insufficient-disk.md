# backend publication lacks runner disk space

status: open; release artifact unavailable
origin: 2026-10-16 release audit after pr #655
area: ci / immutable backend publication

the attempt-1 [publication run](https://github.com/NielsdaWheelz/nexus-web/actions/runs/39002507022)
for `d5186a981fae33b39ad8ecd5d3e77c835f65947f` failed at
`2026-10-17T04:25:42Z`, step `admit publication disk use`:
`/home/niels/.local/share/docker` had 6,482,669,568 bytes free;
8,589,934,592 were required. api/worker builds and the manifest upload were
skipped. passing pr checks and a vercel preview do not supply that candidate.

recover capacity on the ci runner through owned cleanup; preserve other
workloads and the admission floor. publish a fresh source commit after recovery.
the existing first-attempt policy skips publication on workflow reruns. this is
separate from the production host's post-pull image-retention issue.

done: a fresh eligible first-attempt run publishes its api/worker digests and
candidate manifest successfully, with matching source/runtime identities and
public digest-access proof.

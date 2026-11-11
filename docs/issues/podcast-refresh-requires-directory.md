# publisher refresh during a directory outage is unqualified

source repaired; the recorded runtime qualification remains open. current
`python/nexus/services/feeds/sync.py` admits independent head checks and
`feeds/traversal.py:121` fetches publisher pages directly. shared feeds replaced
the old podcast sync owner in `8aa22f123` (#920); the historical mandatory
directory request is no longer a current source defect.

the remaining boundary is observed refresh and identity behavior during an
outage. qualify a healthy subscribed feed while its directory is unavailable,
then an actual publisher failure and a changed enclosure. refresh must continue
in the first case, expose the second and avoid duplicate or conflated episodes
in the third. use the current [feed contract](../modules/feeds.md) and
[paired release](release-feeds-selection.md), not the retired podcast plan.

resolved after those observations on identified artifacts, or an explicit
owner disposition. this cleanup performed no runtime or deployed qualification.

# podcast acquisition provider failures escape domain translation

status: deferred. origin: 2026-10-04 independent fresh source review, tree `87f64269e3de72e7c7ee774256a6038949ae7e4f`. area: podcast / acquisition failure boundary.

`python/nexus/services/podcasts/episode_acquisition.py:57` calls discovery resolution without translating `BrowseTargetNotFound` or `BrowseProviderFailure`. `services/browse/service.py:275–288` delegates to the provider resolver; only browse routes translate those expected exceptions (`api/routes/browse.py:63–66,70–94`). acquisition instead reaches the generic 500 `E_INTERNAL` boundary in `responses.py:144`. no live reproduction is claimed.

impact: a disappeared discovery episode or unavailable/rate-limited provider becomes an owned defect rather than a classified acquisition refusal.

prerequisite and fix: establish acquisition's expected failure contract at its native boundary, retaining real sealed-target/provider parsing and the current replay-before-resolution order. this failure repair is outside the selected success cutover.

acceptance: real native/BFF acquisition controls for disappeared, unavailable and rate-limited targets report the agreed domain errors; no placement/admission occurs, and successful replay remains unaffected.

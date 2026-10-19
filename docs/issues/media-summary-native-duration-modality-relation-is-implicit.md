# media summary native duration modality relation is implicit

status: deferred. origin: 2026-10-04 fresh podcast source census at `0adfa3ae1a7c40cd462f725e3ab7a6f9807d50fb`. area: shared media / success contract.

`python/nexus/schemas/media_summary.py:26–36` permits any Read/Listen duration with any media kind. the 2026-10-09 media-row cutover removed the duplicate browser conversion; `apps/web/src/lib/media/mediaSummary.ts` now aliases generated wire types. the sole constructor in `services/media.py:546` selects duration through `_summary_duration` and the reading-time owner. current live document/video/audio projections have the expected modalities; no malformed live summary was observed.

impact: the cross-field semantic guarantee belongs to the producer, and remains implicit in the generated declaration. there is no longer a divergent browser success validator.

prerequisite and fix: determine whether the native schema must encode this relationship beyond the current single producer. keep same-deploy consumers on generated types; do not restore the retired decoder. add a native guarantee only if it absorbs a present contract requirement rather than defending against hypothetical local mutation.

acceptance: native output rejects mismatched present modalities/video duration, preserves valid present/absent summaries, and every affected display conversion remains equivalent.

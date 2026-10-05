# media summary native duration modality relation is implicit

status: deferred. origin: 2026-10-04 fresh podcast source census at `0adfa3ae1a7c40cd462f725e3ab7a6f9807d50fb`. area: shared media / success contract.

`python/nexus/schemas/media_summary.py:19–36` permits any Read/Listen duration with any media kind. `apps/web/src/lib/media/mediaSummary.ts:84–95` rejects a present duration unless podcast_episode uses Listen, documents use Read, and video has no duration. current source projection constructs the expected values; no malformed live summary was observed.

impact: the generated declaration does not own this cross-field guarantee; the shared typed display conversion still checks it. that conversion serves browse, search, contributors, libraries, resonance and lectern.

prerequisite and fix: coordinate the shared summary output contract with its current producers/consumers before removing the browser check. the podcast slice retains the conversion unchanged.

acceptance: native output rejects mismatched present modalities/video duration, preserves valid present/absent summaries, and every affected display conversion remains equivalent.

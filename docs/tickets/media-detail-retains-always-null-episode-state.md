# media detail retains an always-null episode state

status: open · origin: 2026-10-02 typed media detail cleanup, baseline `d1f7747a4` · area: media wire

`services/media.py:723` supplies `episode_state=None` for every `MediaOut`;
its baseline constructor omitted the field and the schema default was `None`.
`schemas/media.py:239` exposes the nullable field. the actual detail/list
before-after receipts preserve null; apps/python consumer census finds no
media-detail reader of it. the real podcast episode/listening state has separate
projections, schemas and `episodeTranscript` consumers.

impact: this dead list/detail field adds wire and decoder surface without a
represented fact. the current typed-ingress cut preserves its byte contract.

prerequisite: complete the ingress census, including independent clients.
fix: hard-delete only `MediaOut.episode_state` and its projection/type residue.
retain real podcast/listening state, episode commands and listing projections.

acceptance: no field, projection or decoder residue for this `MediaOut` member;
other episode-state commands/listings and media detail behavior are unchanged;
`./scripts/test` passes.

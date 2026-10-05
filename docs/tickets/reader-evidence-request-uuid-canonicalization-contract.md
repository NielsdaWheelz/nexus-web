# reader evidence request uuid canonicalization needs an explicit contract

status: deferred. origin: 2026-10-04 independent fresh source review, source tree `87f64269e3de72e7c7ee774256a6038949ae7e4f` (reviewed head `99254ca4726475e6cac2bc59dcc7ce71c3097930`, merged `0adfa3ae1a7c40cd462f725e3ab7a6f9807d50fb`). area: reader / request identity.

`apps/web/src/app/(authenticated)/media/[id]/mediaEvidenceResolution.ts:511–515` compares raw request media/evidence strings with canonical uuid strings from native output. `python/nexus/api/routes/reader.py:36–37` accepts uuid-typed path values. removing the browser correlation check can change uppercase/braced or other accepted noncanonical input behavior, independently of the native output relationship checks. no live failure is claimed.

prerequisite and fix: the reserved reader owner must establish request syntax/canonicalization and output correlation together before deleting or relocating this check. do not choose normalization from the output schema alone.

acceptance: real hash/BFF/native arrival controls qualify canonical, uppercase/braced, invalid and wrong-media ids, with explicit intended navigation, error and request/response identity behavior.

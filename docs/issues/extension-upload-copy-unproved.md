# extension upload copy claims nonreceipt from weaker evidence

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: extension upload copy claims nonreceipt from weaker evidence; the user receives a stronger claim than the owner knows.

evidence: paths under `apps/web/src/` unless rooted. extension/popup.tsx:72 says nexus didn’t receive this upload for E_STORAGE_MISSING; python/nexus/services/media_upload_sessions.py:889-891 only proves HEAD currently found no object. extension/nexusClient.ts:235-244 says the upload didn’t finish after a lost response or non-ok answer, neither of which proves the PUT never completed.

resolution proof: use cause-free inability-to-confirm copy for lost upload replies and current-absence copy for a missing stored object. keep actual retry and recapture ownership.

source finding; behavior qualification and correction remain pending.

# share capture loses known url acceptance on later read failure

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: share capture loses known url acceptance on later read failure; the user receives a stronger claim than the owner knows.

evidence: paths under `apps/web/src/` unless rooted. ShareCapture.tsx:227 calls addMediaFromUrl without onAccepted; ingest.ts:278-285 already constructs the accepted source, then :289-296 can throw from a later GET. ShareCapture.tsx:237 classifies that read as an unknown write, and its retry sends POST again.

resolution proof: retain the accepted result separately; a read failure says the source was saved and offers read-only retry. do not resend the accepted command.

source finding; behavior qualification and correction remain pending.

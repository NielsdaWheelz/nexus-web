# extension read failures infer navigation from port or injection failure

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: extension read failures infer navigation from port or injection failure; the user receives a stronger claim than the owner knows.

evidence: paths under `apps/web/src/` unless rooted. extension/background.ts:858-864 claims the page changed whenever its content port disconnects. :1117-1126 turns any E_CAPTURE_INJECTION into a claim that the page is gone; :835-841 originally admits executeScript failure without proving that.

resolution proof: state inability to read the page or link without claiming navigation or disappearance; keep recapture guidance only where the press actually reacquires.

source finding; behavior qualification and correction remain pending.

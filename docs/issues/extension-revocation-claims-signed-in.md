# extension disconnect feedback claims server sign-in after an unknown revoke

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: extension disconnect feedback claims server sign-in after an unknown revoke; the user receives a stronger claim than the owner knows.

evidence: paths under `apps/web/src/` unless rooted. extension/background.ts:588-603 keeps the local credential if DELETE session fails; extension/nexusClient.ts:180-185 treats204/401 as settlement. a DELETE can commit before its reply is lost. extension/popup.tsx:236 then says this browser stays signed in, but only the retained local credential is proved.

resolution proof: say not sure disconnection finished, or omit the asserted sign-in reason; retry the existing revoke. prove the server-accepted/lost-response branch.

source finding; behavior qualification and correction remain pending.

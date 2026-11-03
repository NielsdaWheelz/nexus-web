# refused-sync slip can retain a safety claim after a local commit fails

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only finding.

problem and impact: while the account stays `Refused`, an already visible plain slip can keep `they’re safe on this device.` after a new local commit fails. the live account row drops that reason, but the visible slip does not.

evidence: `apps/web/src/lib/account/condition.ts:43-48` leaves a nonstopped failed commit under `Refused`; `:83-93` deliberately removes safety reasons when `commitFailed`. `apps/web/src/lib/authored/provider.tsx:192-199` updates only a ref when writing changes; the effect that raises/retracts the plain slip does not depend on that change. the separate risk hold appears at `:201-216`.

reproduction: show a refused-sync slip with no failed commit; before its visible-time expiry, fail a local commit without stopping the store. the existing safe-on-device reason remains beside the risk hold.

resolution proof: the stale safety reason is retracted or updated as soon as the local failure starts; it must not create a fresh attention onset solely because writing state changes. verify the same still-Refused transition, with the slip already present.

the account feedback owner must withdraw the stale safety claim without treating the local failure as a new sync-condition onset.

# accepting saved text briefly leaves draft status

at `d90ed1033`, `texts.ts:414` updates the selected value and clears its conflict after `resolveDraftConflict`, without recomputing `writingState`. the preceding `receiveDraft` computed status from the old editor value against the newly accepted saved base. the editor can therefore display `draft saved on this device` after accepting clean saved text until another journal notification runs `refreshState`.

recompute status after the final value update. resolved when accepting the saved comparison immediately reports the status of that selected value without waiting for cleanup or another journal event.

source repair: `resolveConflict` calls `refreshState` immediately after its final selected-value update. live qualification remains pending.

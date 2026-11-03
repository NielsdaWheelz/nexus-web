# context reports local absence before its reading scope is available

problem: the context row says `not on this device.` whenever an authored query returned data without an item, including `scope_available === false`.

impact: an existing highlight with an unavailable reading scope is presented as absent from the device.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; `apps/web/src/lib/chat/contextItems.ts:18-21` selects the excerpt query and returns null for empty rows; `apps/web/src/components/chat/ChatContext.tsx:155-157,164` treats any data as a completed absence proof. `node/authored/src/queries.ts:459-470,508-520` returns empty rows with `scope_available:false` for an unavailable excerpt scope.

resolution: only a completed available scope may assert `not on this device.` or `{type} unavailable`. while scope is unavailable, keep the current pending/type presentation or the actual scope-owned fact. no new prose is needed. prove scope-unavailable rows never claim device absence and genuinely absent available-scope rows still do.

status: source finding only; no runtime journey run. correction and behavior qualification remain pending.

# disposable runtime has no generation catalog

problem: the isolated runtime cannot currently seed a real saved chat message
through chat admission. its generation catalog depends on the native codex socket,
which the disposable service does not expose.

evidence: action-menu run `20261020-004357-677385891000`,
`GET /api/llm-catalog` returned 503 `E_GENERATION_RUNTIME_UNAVAILABLE` with
`Generation catalog is temporarily unavailable`. `services/generation/catalog.py`
requires a real codex catalog before composing provider rows. this checkout has no
configured generation credentials; the unqualified openai key is embeddings only.

impact: chat message-menu live qualification remains unproven. page/resource and
nexus menus can still use real service reads. do not fabricate model selections,
insert messages internally or repurpose embedding credentials.

resolved when a supported isolated runtime exposes an actual generation catalog
and admits/cancels a real chat run, then the message-menu journey passes.

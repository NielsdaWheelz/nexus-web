# oracle rest readers repeat owned outputs

status: deferred. origin: 2026-10-04 pr #499 follow-up, rechecked at `908de01b`; area: oracle rest hydration. source verified; runtime not run.

`apps/web/src/lib/oracle/oracleReadingWire.ts:161–184,351–480` declares and rebuilds create/detail responses; `apps/web/src/app/(authenticated)/oracle/OracleAlephGrid.tsx:16` declares a summary subset. the canonical create, summary and detail models exist in `python/nexus/schemas/oracle.py:115,159,309`; `python/nexus/services/oracle.py:386–415,460–479` builds validated outputs. their named response roots are absent from generated wire. this is duplicated ownership, not evidence of missing storage validation. the string-counting defect has its own ticket.

if selected, expose those existing named route outputs and reuse generated fields. preserve emitted nullable/default keys, phase controls, image-url brands, citation adaptation and producer normalization. acceptance: create, pending, complete and failed reads preserve full typed values and hydration/reload/activation. measure generated growth separately: all-source gain is unmeasured and may be negative. this is not an adopted reduction slice.

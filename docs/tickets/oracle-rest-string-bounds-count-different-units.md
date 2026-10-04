# oracle rest string bounds count different units

status: open. origin: 2026-10-04 pr #499 follow-up, rechecked at `908de01b`; area: oracle rest hydration. source verified; runtime not run.

`apps/web/src/lib/oracle/oracleReadingWire.ts:196–207` counts utf-16 units with `.length` for question, motto and gloss bounds. the request (`python/nexus/schemas/oracle.py:111`) and synthesis (`python/nexus/services/oracle.py:1679–1683`) count unicode code points. a valid 141-character non-bmp question fits the owner's 280-character bound but measures 282 in the browser and fails hydration. this is a source-derived witness, not an observed journey or historical-row claim.

count the same units as the owner, or retire the redundant bounds in a separately qualified typed rest change. preserve producer normalization and existing constraints; no new limits. acceptance: a real public create/read hydrates the valid non-bmp question, while canonical over-limit rejection remains. the broader output-contract duplication is tracked separately.

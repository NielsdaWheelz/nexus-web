# llm tool position replay pointer has no current owner

- status: open
- origin: 2026-10-04 source audit at `bc898bcb2975008c6ba42c02ef23895bea2492e9`
- area: native llm tool position storage

`LLMToolPosition.replay_of_position_id` is a nullable self-reference in `python/nexus/db/models.py:1874-1878`, created by migration `0255_native_agent.py:79-85`. a whole-source reference search finds no writer, reader, constructor, route, or projection beyond those declarations. current replay uses callback reply and result evidence instead. the column adds a second apparent replay authority without a current application contract. this is source-unused, not proof that every retained row is null.

before removal, inspect retained data and declare how any non-null historical value is handled. then remove the obsolete mapped field and column/fk while preserving canonical tool-position and callback replay. source census plus a retained-data check and ordinary callback replay proof establish resolution; no broad ledger rewrite is needed.

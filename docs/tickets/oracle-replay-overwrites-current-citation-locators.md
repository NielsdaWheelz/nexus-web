# oracle replay overwrites current citation locators

status: open, source-qualified; live reproduction not run · origin: 2026-10-04 simplification audit at `58bdd8a77bb865450c8c197c4c35ca904b2ddaa5` · area: oracle reading hydration

`services/oracle.py:328-335,375-383` rebuilds current passage citations through the shared reader resolver. `oracle_corpus.py:373-413` can repoint a stable anchor after reindex. historical passage events retain the original resolved citation (`oracle.py:928-941`). browser `OracleReadingPaneBody.tsx:151-170,210-219` then replays those events over the current passages, replacing each phase. the rendered citation at `664-669` can therefore open an old locator or remain clickable after the current resolver returns no locator. the service paths are under `python/nexus`; the pane is under `apps/web/src/app/(authenticated)/oracle/[readingId]`.

make the canonical read own current citation navigation; retain historical prose and citation identity. stop historical replay from overwriting resolved navigation, or use one native reading snapshot for hydration and stream completion. no log/table deletion is justified without conserving omens and existing readings.

acceptance: in an isolated valid completed reading, repoint its stable anchor through the actual resolver, then reopen and hard reload. the browser chip activates the current native locator; an unresolved target renders typographically. prerequisite: valid readable media/anchors and native publication fixtures. provider execution and production mutation are unnecessary.

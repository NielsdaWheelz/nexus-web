# apparatus binding recomputes canonical structure

status: open. origin: 2026-10-04 source audit at `bbfd1df4`; area: reader apparatus / ingest. priority: p3.

`html_apparatus.py` computes stamped-subtree text and full canonical structure while binding locators, then derives note groups by rebuilding that structure and calling the span helper again. ordinary epub ingestion already retains the same fragment structure for navigation. this repeats canonical interpretation and work; no runtime cost or product failure has been measured. the existing prefix-scan ticket concerns a different earlier phase.

acceptance: binding and groups use the existing `CanonicalStructure` as their explicit coordinate input where the producer already has it, without another whole-fragment pass. preserve exact unique-text fallback, identities, rich bodies, offsets and ordered outputs. keep repair's newly stamped and unchanged stored html as distinct snapshots. compare bounded actual article/epub/x and repair outputs and measure work before closing.

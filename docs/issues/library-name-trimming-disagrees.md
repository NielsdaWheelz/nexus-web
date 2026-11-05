# library name normalization disagrees across the boundary

`apps/web/src/lib/libraries/views.tsx:12–16` uses javascript `trim()`; `python/nexus/services/libraries.py:164–171` uses python `strip()` and `casefold()`. a name such as `U+0085 + All + U+0085` can be offered by the chooser but rejected by the server as reserved.

choose one normalization contract at the shared library boundary, then qualify that actual chooser/create request and reserved-name refusal. do not add an import-specific normalizer. ordinary ASCII creation and retry passes do not close this discrepancy.

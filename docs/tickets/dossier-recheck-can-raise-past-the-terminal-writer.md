# a dossier recheck can raise past the terminal writer and leave a build active forever

status: open · origin: 2026-09-21 reauthoring (dossiers review) · area: dossiers

`services/artifacts/engine.py` `_inputs_are_current` catches `NotFoundError`
only around `binding.authorize`; `binding.recheck` recollects the subject and
can raise `DossierInputTooLarge` (conversation, page and note subjects) out of
the success and failure terminal writers. The job attempt then fails instead of
writing a terminal child; after three attempts the build stays active with no
terminal, so the head refuses new builds until an operator intervenes.
pre-existing: the old engine had the same shape.

repro: build a dossier for a note, then grow the note past the input bound
before the build finishes.

fix: treat a recheck failure as an `InputsChanged` terminal (the same outcome
a witness mismatch produces) instead of letting it escape.

resolved when: every path out of the terminal writers writes exactly one
terminal child.

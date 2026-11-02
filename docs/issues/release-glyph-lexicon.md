# release glyph lexicon

the glyph lexicon changes drawings, one stroke weight, lint and one visible word
(the find bar's `results`). it adds no wire, schema or storage change, no
preflight and no owner step. nothing a client sends or stores differs.

it does not deploy alone. the main it merges already carries acquisition's wire-18
break (`release-import-acquisition.md`) and the closed media kind's production
preflight (`release-media-kind-closed.md`), so any sha holding the lexicon ships
with the next release of main. today that is acquisition's paired wire-18 release,
itself riding feedback-homes' if that is still unshipped, run only after the
media-kind preflight returns no rows. that release builds the apk and the xpi
from the same sha as hosted web, so the phone's packaged bundle and the extension
popup take the lexicon with it.

resolved when hosted web, the apk and the xpi are released from one sha that
contains the lexicon's merge. delete this record then.

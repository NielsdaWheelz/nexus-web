# linking a passage to its own book fails on first use

when the account has no local stub for the book, open a complete reader note,
choose “link to…”, then select the containing book. on firefox at `1ba95fbf2`,
the picker verified the note and then displayed “couldn’t save this link on
this device.” selecting a library instead committed the exact passage anchor
and replicated the link. the failing action leaves an unresolved local write.

`apps/web/src/lib/resourceGraph/links.ts:220` prepares a source stub for
the passage owner. `links.ts:147` separately prepares one for the direct
endpoint. `links.ts:153` puts both in one causal change. these lines are
identical on the preceding main `5a1ca39e2`. for the real fixture both
captures had kind `media`, publication `null` and the same ref. their labels
were `source` and `Retained repair example`. replay through
`node/authored/src/merge.ts:52` raises “One register stamp identifies
conflicting values”.

have link preparation consider source captures already planned for this
command. enrich the pending stub with the known endpoint label, preserve
its publication, and emit one capture. verify both endpoint orientations
from an account without the stub. the exact passage anchor and the book
must have one replicated link with the displayed title, and linking another
destination must still succeed.

# consuming an empty item retains its standalone note

`OutlineHistory.replaceReference` unlinks the original occurrence and adds
the selected target's link. undo restores that same incoming link. consuming
the last link to an ordinary empty note leaves its resource visible by ref
and present in the corpus.

retaining the resource preserves independent occurrences and concurrent
writing. if excluding unused blank notes from the corpus becomes necessary,
define a causal retirement rule that protects those writes and undo. close
when a last-link replacement and a replacement of one of two links have the
agreed standalone behavior after synchronization.

# a different settings command hides unanswered recovery

problem: while rename is unknown and the library remains readable, settings still
allows delete. its accepted204 clears unknown but retains the rename request.
the deleted view hides Save and Hold, while the draft guard remains unconfirmed.
copy and deliberate guarded abandonment survive; exact rename recovery does not.

source atd7d96c573 (also present at57f76e33):
`apps/web/src/components/LibrarySettingsDialog.tsx:144-146,165-167,189,203-211,235-252`.
rename success also clears unknown; the reverse delete-unknown to rename path
needs the same single-command ownership audit. delete204 can acknowledge masked
invisible absence (`python/nexus/services/libraries.py:337-339`), so it cannot
prove that a different earlier rename settled.

fix at this existing draft owner: do not admit a different operation while a
command remains unanswered. preserve exact same-command retry, changed words,
copy and deliberate guarded close. no new registry or lifecycle owner.

resolved when both cross-command directions cannot replace retained uncertainty,
while actual same-command acknowledgement and guarded abandonment still work,
in both browsers with independent review.

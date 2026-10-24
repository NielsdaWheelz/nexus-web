# empty provider page qualification

gap: live collection qualification has not observed a raw empty page with a
non-null next cursor. zero visible local matches are a separate condition.
impact: this upstream edge has source review, without live proof. the owner
accepted this verification limit for the collection-loading change.

evidence: `python/nexus/services/browse/youtube.py:76-97` skips unclassifiable
provider items while preserving the upstream next token. local keyset lists and
browser search compute continuation after admission; valid local seeds cannot
force this provider response. shared list continuation remains implemented for it.

resolved when an actual provider response with this shape is observed and the
browser advances quietly to its next page without terminal-empty copy or losing
recovery. do not fabricate successful application payloads or add product seams.

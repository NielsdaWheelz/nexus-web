# teammate context for a later brief workflow

deferred beyond [the selection contract](../modules/suggestions.md). the motivating example asks for
evening teammate questions and a morning brief; v1 has no outbound questioning.

resolve recipients, delivery channel, evening time, authorization, response
deadline and nonresponse behavior before implementation. reuse existing
communication/generation owners where available. replies should become ordinary
attributed messages or notes with source identity and time, consumed by the same
bounded context queries. preserve the difference between the user's intent and
another person's interpretation; do not create a separate hidden interest store.

accepted user-message context has an existing source owner in
`python/nexus/services/chat/admit.py`; authored notes remain owned by
`node/authored`. these seams do not themselves provide an external teammate
integration or authorization to contact anyone.

resolved when an explicitly authorized evening exchange produces attributable
context used by the agreed morning edition, missing replies do not block it,
and independent review verifies attribution and permissions. no outreach occurred.

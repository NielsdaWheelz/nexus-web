# context-only chat creation has no loss guard

`apps/web/src/lib/chat/conversationIndex.ts:40` creates an empty chat with context
through `POST /conversations`. uncertain retries retain the id only in a
workspace offer. dismissal or reload forgets that recovery; another creation
can leave duplicate empty chats. there is no authored draft in this operation.
this predates the activity cutover: the former footer also allowed dismissal.

`lib/chat/commands.ts:38` owns send/repeat/delete, not this context-only creation;
`components/feedback/Activity.tsx` correctly dismisses optional offers. hiding its
close button would not supply command ownership, exact retry admission or loss
protection. presentation must not infer required recovery from tone or attention.

a separate repair should move context-only creation into the existing account
chat command owner and project a condition while its outcome is unknown. retain
its exact create id/body, explicit discard policy and account fencing.

resolved when a real lost-response creation remains recoverable across pane
removal, retries the same id without duplicate creation, and its departure policy
is explicit. broader chat command lifecycle changes are outside this presentation
cutover.

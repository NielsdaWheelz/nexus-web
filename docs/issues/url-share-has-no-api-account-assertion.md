# url share has no api account assertion

problem: URL ShareCapture does not mount AuthoredProvider or establish an API
account binding. capturing the nullable binding therefore does not identify the
account that owns its URL command.

evidence at14400e332: `apps/web/src/app/share/ShareCapture.tsx:75-115` only reads
a binding and mounts AuthoredProvider for plain text; URL content receives
account=null. `lib/api/client.ts:18-27,331-347` captures that optional binding
and adds X-Nexus-Account only when it exists. a surviving browser capture page
cannot use this token to detect another document changing the shared cookie jar.

impact: absent an account assertion, a later explicit URL retry uses the current
cookie's authority, rather than proving it is the original account. destination
authority and removal guards remain; this is not a reproduced cross-account write.

native ShareActivity separately pins its account and discards a changed-account
document on resume (`ShareActivity.kt:92-102`); that lifecycle boundary does not
establish a browser account assertion. document/command identity fences remain
useful but must not be described as account identity when the token is null.

resolve at the standalone capture admission owner using a real account identity
and the existing API binding/assertion contract. qualify an actual account switch
while a URL save is unanswered, with no replay into the replacement account. do
not infer identity from library ids or add a capture-local authorization scheme.
this existing admission change is separate from retaining a known save receipt.

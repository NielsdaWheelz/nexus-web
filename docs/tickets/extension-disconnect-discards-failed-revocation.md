# extension disconnect hides failed token revocation

status: open · origin: 2026-09-23 firefox v1 review · area: extension auth

`apps/extension/popup.js:317-326` ignores both network failure and non-success
http responses from token revocation, deletes the local token, then says token
removed. the server token can remain valid and its local revocation handle is
lost. this is source-confirmed; no live revocation request was made.

fix: distinguish confirmed server revocation from local forgetting. ordinary
disconnect should handle a failed revoke visibly and retain a retry path; an
explicit local-only removal may remain an intentional choice.

acceptance: successful disconnect revokes the token; an offline/error response
does not claim revocation or silently discard the only retry credential.

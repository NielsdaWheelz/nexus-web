# shelf frame policy is delivered as metadata

`apps/web/src/shelf/index.html:10` places `frame-ancestors 'none'` in a csp
meta element. chromium ignores that directive there. the real downloaded epub
journey logged the warning at source `52a49c069`, private run
`20261023-074055-04657c6658ec`.

the isolated shelf retains its own origin, connect policy and main-frame bridge
checks; this observation does not prove a data exposure. the declared framing
policy itself is ineffective. ordinary installed app responses already send
shared security headers.

move this directive to the shelf document response header at its delivery owner,
with one source for the existing shelf policy. resolved when actual shelf document
headers carry the policy and a framing attempt is refused. keep this with the
separate downloaded-reader work; do not remove the warning by dropping policy.

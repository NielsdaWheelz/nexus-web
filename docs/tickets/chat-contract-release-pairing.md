# chat wire cutover requires one release vector

status: open; production pairing unverified · origin: 2026-09-28 pr #412 merge (`27e961be6`) · area: chat release

pr #412 changed the saved chat-run response and its exact web decoder. the old
backend sends `cancel_requested_at` and a different `run_selection` shape
(`fbd08ba68:python/nexus/schemas/conversation.py:887-899`); the new web expects
the keys in `apps/web/src/lib/conversations/messageWire.ts:81-97` and rejects
extras at line 201. the new revision header cannot protect a new web client
talking to an old backend that does not check that header.

this is a release-order hazard, not an observed outage on the product domain.
on 2026-09-28, public frontend and api `/version` both returned deployed
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; the api reported database
`0241`. the pr #412 vercel build was ready as a production-target candidate,
but `nexus.nielseriknandal.com` still served the old sha. the runbook
(`deployment.md:77-79,124-129`) requires backend migration and health before
promoting the matching web deployment.

prerequisites: resolve the `0246` uncertain-work blockers, run the `0250`
production preflight, and verify the release backup. release one exact current
main sha through `deploy/hetzner/deploy.sh`; do not promote a staged web build
against the old backend or add a dual-shape decoder for this hard cutover.

acceptance: the release controller proves the same sha on the backend and
custom-domain web, at the baked database head; authenticated new and saved chat
reads, send, same-run stream recovery and stop succeed after promotion. if an
early promotion occurs, restore the previous compatible web alias until the
backend can be released.

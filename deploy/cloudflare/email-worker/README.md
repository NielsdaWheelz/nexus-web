# email import worker

this adapter sends cloudflare email routing events to `POST /ingest/email`.
`nexus-post-room` remains the existing deployed resource identity; the product
calls this email import. receiving-address activation is a separate
[release gate](../../../docs/issues/release-email-import.md).

## contract

both ends bound raw mime at 2 mib. the worker canonicalizes the full receiving
mailbox, sends `X-Nexus-Wire`, and signs these exact bytes with hmac-sha256:

```text
UTF8("nexus-email\n" + WIRE_REVISION + "\n" + canonical_recipient + "\n") || raw_mime
```

`X-Nexus-Email-Signature` carries lowercase hex;
`X-Nexus-Email-Recipient` carries the canonical full mailbox. the revision imports
from the generated web wire module, never from a separately configured value.

only a validated 200 acceptance/duplicate/suppression envelope acknowledges.
only `400 E_INVALID_REQUEST` and `413 E_SOURCE_TOO_LARGE` permanently reject;
worker-side size overflow rejects with the same fixed copy. all other responses,
unreadable replies and transport failures throw. thrown exceptions do not prove
smtp deferral: qualify real temporary failure and recovery before activation.
see the provider's [handler contract](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).
diagnostics contain status, code and request id, never message content.

## paired release

follow [deployment.md](../../../deployment.md) for configuration publication and
the ordinary backend release. this component runbook authorizes no deployment.
the backend needs valid `EMAIL_INGEST_HMAC_SECRET`, `EMAIL_INGEST_ADDRESS_SLUG`,
`EMAIL_INGEST_DOMAIN` and `EMAIL_INGEST_OWNER_USER_ID`; partial configuration
hides the address and makes admission unavailable. the worker needs the same
secret plus `EMAIL_INGEST_API_URL`, the full https ingress endpoint.

from this directory, provision secrets with `wrangler secret put` and verify the
bundle with `wrangler deploy --dry-run --outdir <private-output-directory>`.
`wrangler deploy` publishes the worker. provision the domain's email routing rule
for the exact mailbox only as the release gate permits.

every wire bump requires worker and backend builds from matching source;
a deployed worker does not acquire later generated revisions automatically.
coordinate secret/address rotation the same way, with no legacy grace path.
prove one real arrival, duplicate suppression, and temporary-failure recovery
before exposing the address. no latency or delivery guarantee follows from a
successful api-only check.

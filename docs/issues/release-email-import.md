# email import activation

status: open optional activation; application implementation leaves production inactive.

choose the receiving domain and provision its cloudflare email-routing rule, worker access and private address. publish the four ordinary backend email configuration keys and matching worker secret/api url through `deployment.md`; deploy worker and backend from matching source. the existing worker resource name `nexus-post-room` is an operational identity.

every wire revision change while email is active requires a paired worker release. a deployed worker does not acquire a new source revision automatically. retain exact worker/backend release identities. see [the worker runbook](../../deploy/cloudflare/email-worker/README.md).

qualification before exposing the address: prove one real message arrives in all with readable content and ordinary history; redelivery creates no duplicate; removal suppresses redelivery; a temporary owned dependency failure never bounces valid mail and real delivery resumes after recovery. application tests of a thrown handler do not prove smtp deferral.

if cloudflare cannot preserve delivery across temporary failures, keep activation blocked and resolve transport separately. never restore a bounce-on-server-error path. resolution requires recorded live arrival, duplicate and real deferral/recovery evidence, alongside the deployed identities.

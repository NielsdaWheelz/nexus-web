# reading preparation has no useful visible progress

On deployed dcee, Firefox reported only “syncing” during expensive initial
reading/search preparation. Prior scope failures misleadingly said notes could
not finish syncing. The account status did not distinguish saved writing from
derived reading inputs or show durable progress.

The current repair uses the existing sync status/detail owner and durable scope
counts: metadata records loaded, then completed/total readings. No metadata
percentage or completion time is guessed; “up to date” still requires the whole
account contract. Reading-preparation failures must not mask writing failures.

Resolve after both actual installed clients show advancing preparation separately
from writing acknowledgement, handle a preparation failure truthfully, and
become current only after complete publication.

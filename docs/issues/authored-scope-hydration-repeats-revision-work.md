# repeated scope preparation work

The dcee production query repair removed the initial 30-second timeout, but
Firefox still performed 7–15-second scope requests for at most 100 metadata
records per page. Its 22,201 metadata facts require at least 223 such pages,
followed by text hydration. Every status/text page recomputed the full metadata
stream, and a new global revision retransferred unchanged reading text. This
slowness is distinct from the authored-note snapshot's initial provisioning cost.

The current repair derives the fence from canonical membership/publication
dependencies, fills the existing metadata byte bound, expands text only for the
requested reading, and reuses exactly unchanged completed active readings after
fresh metadata. Authorization, immediate revocation, final revision/store fences
and local writing durability remain required. Namespace 2 causes one initial
derived-preparation restart; incomplete first-setup staging is not retained as a
cross-revision donor.

Resolve after affected membership/publication/reuse checks and actual installed
clients complete preparation with finite progress. Static/source review alone
does not establish completion or production latency.

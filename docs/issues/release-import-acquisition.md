# qualify paired-client import acquisition

the historical wire 18 acquisition cut replaced destination order revisions with
library ids and a shared removal guard. current behavior belongs to
[imports](../modules/imports.md) and [deployment](../../deployment.md); later
wire/schema changes supersede instructions to release wire 18 again.

remaining acceptance on identified hosted, android and signed firefox artifacts:
two links submitted together into one named library both land; a removal
mid-batch refuses the rest; ordinary placement still refuses stale order.
exercise the add flow, android share and extension capture separately.

commit `88e92445b` ([pr 901](https://github.com/NielsdaWheelz/nexus-web/pull/901))
corrects the old fixed extension-manifest instruction: use the manifest belonging
to the paired source, with owner signing. it records no additional acquisition
journey proof. [feedback release](release-feedback-homes.md) preserves the
specific owner-waived installed-client observations.

close after these actual client journeys or an explicit owner disposition.
preserve current durable-format and pending-command constraints during any
future release or recovery; the old blanket code-only rollback is obsolete.

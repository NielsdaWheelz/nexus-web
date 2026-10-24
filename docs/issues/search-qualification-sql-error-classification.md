# retain attributable database errors during qualification

the historical diagnostic10 discarded one postgres error before capturing its
sqlstate, severity and timestamp. that error is unrecoverable; do not classify
it retrospectively or claim the historical run was error-free.

current integrated diagnostic110 retains private raw logs and request-correlated
stages. its four postgres errors are all 57014 cancellations at phase expiry.
a separate log/F0000 notice follows the diagnostic configuration reload: restored
on-disk listen-address/shared-buffer values require restart. effective readback
remains 127.0.0.1/64mb/jit-off; the exact original auto-configuration and logging
level are restored. no fatal/panic/warning appears in that browser interval.

browser run 113 retains all sixteen postgres errors as 57014 cancellations with request-correlated api expiry; no new unclassified error is observed. startup logging uses an explicit postgres flag, with no configuration reload.

remaining: preserve attributable error coverage in complete browser/maintenance
qualification. record every unexpected error and resolve its cause. keep raw
private logs until cleanup and classification finish; never launch a separate
runtime solely to repair the historical receipt.

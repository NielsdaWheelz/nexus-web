# mobile chat send click needs isolated qualification

problem: mobile browser fixture setup clicked send on a filled chat composer,
but the draft remained and the transcript stayed empty. later qualification used
keyboard activation successfully. the cause is not isolated; this is an observed
verification gap, not a confirmed product defect.

evidence: source `6d6a6799c`, run `20261028-150019-f65725da9879`, mobile disclosure
cases at 390px and 700px. their private error-context and trace artifacts show
the retained draft. that fixture selected the last visible pane; subsequent
tests instead select the active pane and wait for stable command state.

reproduce with the active pane, hydrated composer and enabled send button;
compare pointer and keyboard activation on the same state. if reproducible,
repair the responsible activation/layout owner. resolved when an isolated real
browser check proves pointer submission commits once and clears its draft, or
identifies and corrects the fixture cause. no product workaround was introduced.

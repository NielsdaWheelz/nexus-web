# public android attachment retains a setup risk

`AndroidWebView.page()` caches its attachment promise; the installed connector's no-timeout wait can outlive a caller deadline. an expired caller does not cancel the acquired operation. earlier attachment stalls remain unexplained, despite later journeys completing that owner.

`apps/web/scripts/lab/android.ts` now bounds its separate `attachPage` discovery. the native SDK cases use `device.webView(...).page()`, so that change does not prove their attachment fixed. their private owner must settle outstanding operations through real closure and reconcile exact acquired resources.

resolve by identifying the stalled owner and qualifying supported bounded attachment and late-operation retirement without another navigation, fallback attachment or private options. retain setup failure separately from product behavior.

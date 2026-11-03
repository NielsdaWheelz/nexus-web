# capture limit reasons contain uppercase unit prose

problem: two real capture failure reasons compose uppercase MB into a Line.
the unit cannot simply become mb: that changes its meaning. spell out megabytes.

source at06315275 under apps/web/src: `extension/background.ts:994` and
`extension/capture.ts:317` produce the size reason. document acquisition failure
passes through CaptureFailureError/describe/failed phase to popup outer fact
“couldn’t save this capture.” plus that reason. these are displayed producer paths,
not the unrelated nonpresenting content-process resource-limit diagnostic.

fix these two size-reason literals only. retain exact thresholds, document-kind
meaning, transfer behavior and ordinary measurement labels elsewhere.

resolved when both actual outer-fact-plus-reason variants use truthful lowercase
units, fit fourteen words and pass independent source review and canonical gate.

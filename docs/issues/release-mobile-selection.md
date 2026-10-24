# mobile selection release qualification

release remains blocked on native edge-autoscroll qualification. the owner
approved finishing the compact-action change with this blocker retained; do not
expand it into custom gesture handling or reader-layout redesign.

- [edge autoscroll](mobile-selection-native-edge-autoscroll.md): native dragging
  extends the range, but sustained edge scrolling has not been established in
  the required android app/chrome journeys. prove it with real handle input for
  text and pdf; scripted ranges or scrolling are not qualification.
- [start-boundary drift](android-selection-start-boundary-drift.md): chrome pdf
  reversal/regrab remains unqualified. the start-boundary observation also needs
  physical-gesture/control-page diagnosis. no evidence justifies reconstructing
  the browser range in product code.

qualify the final web source and its paired apk together; retain their identities
and actual observations in the pr. keep this record until the native gap is
resolved. desktop behavior, api contracts and persisted schemas do not change.

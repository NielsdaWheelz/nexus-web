# native selection edge autoscroll qualification

native android epub selection extends/reverses and retains compact actions across
most of the visible reader, but the current device probe has not established
edge autoscroll. dragging to the visible bottom leaves source scroll unchanged;
dragging to the underlying scrollport bottom includes `end of book` outside the
source unit, so capture correctly rejects it. this prevents claiming full mobile
selection acceptance.

evidence: frozen `887099923`, samsung sm_s906w/android 16, webview
155.0.8059.43, disposable app `app.nexus.android.selection20261023`.
`TextSurface.tsx` owns the nested reader scrollport; chrome supplies top/bottom
occlusion separately. actual region y25..732; visible bounds y85..608; source
char zero y103.33 remains unchanged after the native edge drag. private probe output: `nexus-mobile-selection-native-full.log` under
`~/.local/state/nexus-verification/mobile-selection-20261023/local/`. no product
workaround.

resolve by establishing a real native edge-autoscroll journey in app and chrome
for text and pdf, or repairing the responsible reader layout/input owner and
rerunning those journeys. distinguish native input-probe errors from a product
defect before changing layout; never substitute scripted range or scroll changes.

additional diagnostic: a separate static html page with a 400px overflow scroller
in chrome 155.0.8059.84, no nexus code, grew a native selection from 7 to 524
characters during a 2.5s swipe; scrollTop moved only 0 to 2px. this does not prove
continuous edge scrolling or establish the root cause. chromium
[561066223](https://issues.chromium.org/issues/561066223) reports a similar symptom;
a maintainer could not reproduce it on another device, so treat it as supporting
context, not a confirmed upstream diagnosis.

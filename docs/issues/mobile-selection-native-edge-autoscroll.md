# native selection edge scrolling remains limited

on samsung sm_s906w/android 16, dragging a native selection handle to the reader
edge extends the selection but does not sustain scrolling in the android app.
the owner reproduced this with a real finger in the actual isolated epub reader
on `57c9e5b10`; its reader owners are byte-identical to release `c5cf4bc27`.
read-only cdp sampling observed no scroll. dragging beyond the source can include
player/book labels; source capture correctly refuses that range.

the current provider is `com.google.android.webview` `155.0.8059.43`; chrome is
`155.0.8059.84`. a plain whole-document webview control also failed the owner's
finger check. that initial quirks-mode observation was followed by html5
standards-mode (`CSS1Compat`) controls with one continuous native touchscreen
gesture, a shared down time, monotonic event times and a 3.6-second edge dwell.
whole-document scroll stayed zero; valid nested-control selections moved only
one pixel and stopped. no nexus code ran in those controls. this does not
establish an engine, input-carrier or layout cause. no product workaround is
justified by the current evidence.

on 2026-10-25 utc the owner explicitly approved shipping and deferring this known
held-edge limitation. normal pdf first-character reversal, handle regrab and
bounded source capture passed in the isolated app and chrome; that does not
establish held-edge scrolling. the waiver does not cover another failed gate.

resolve by establishing sustained real native handle-input scrolling for text
and pdf in both environments, or repairing the responsible owner and repeating
those journeys. separate input-targeting errors from product behavior before
changing layout; scripted ranges or scroll changes do not qualify. private
observations remain in the selection checkout's `.nexus-local/`; the disposable
runtime, app and executable cases have been removed.

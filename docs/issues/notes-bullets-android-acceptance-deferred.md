status: deferred
origin: 2026-09-26 notes bullets pr 2; user requested android checks after the stacked prs
area: android webview acceptance

the physical android phone is unavailable during this pr. desktop browser and
isolated-stack checks cannot establish touch, keyboard, accessibility or input
latency in the installed webview. b7 android acceptance is not run.

prerequisite: reconnect the phone and install the exact reviewed android build.
record its apk hash and account baseline, then inspect the nested/diamond/cycle
specimen, touch hit areas, gboard text and structural commands, screen-reader
names, non-drag move, caret/scroll stability and 100-edit latency.

acceptance: receipt identifies the tested apk and records all b7 android checks
as passed; delete this ticket and its register line.

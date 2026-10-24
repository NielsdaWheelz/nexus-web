# stock chrome 113 crashes in the emulator compositor

on the dedicated api 34 emulator, stock chrome `113.0.5672.136` crashes
`CompositorGpuTh` with a null-pointer `SIGSEGV`. its “chrome keeps stopping”
system dialog blocks native controls while nexus remains alive. october 23
logcat records repeated crashes and `gpu_process_host.cc(1303)` exhaustion.

this reproduces independently on the official media3 documentation page with
emulator `36.5.10`, using both supported `-gpu swiftshader` and `-gpu host`
renderers. dismissing the overlay does not qualify the interrupted journey.

source `c8f6d7383` completed the real custom-tab and installed-app journeys with
official standalone `org.chromium.chrome 158.0.8121.0` while retaining app
webview `113.0.5672.136`. that qualifies this browser/provider combination; it
does not repair or qualify the failing stock browser, or the physical phone.

resolved when a supported stock browser/emulator combination completes the
ordinary external page and actual custom-tab journey without compositor crashes.

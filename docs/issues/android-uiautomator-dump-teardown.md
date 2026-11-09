# android accessibility dump crashes during teardown

on the owned api34 emulator, native outline lab
`20261108-200610-1e655ee9aeb2` stopped before cdp attachment: `uiautomator dump`
returned 137 after printing its unique output path and writing a 2861-byte file.
this blocks strict command-status admission independently of nexus behavior.

guest pid5912 logged `AccessibilityNodeInfoDumper: Fetch time: 7ms` at
2026-11-08 20:07:33.936; `Shutting down VM` at .940; then
`FATAL EXCEPTION: UiAutomation` / `java.lang.RuntimeException: Bad file descriptor`
in `BinderProxy.transactNative`, `AccessibilityInteractionClient` and
`AccessibilityCache.onAccessibilityEvent`. its kill handler sent sig9 at .945.
the guest events log has no lmkd/am_kill entry for this process. nexus pid5809 was
stopped later by the driver's owned cleanup at 20:07:34.583.

the file existed and the device image showed the expected sign-in surface;
the failed run did not read or validate the xml, so it establishes no completed
hierarchy observation or outline journey. later drivers may admit a separately
read, fresh, fully parsed snapshot only while retaining the exact teardown
failure as a distinct fact. incomplete xml and other failures still fail.

evidence is private in the sibling archive
`/Users/nnandal/Documents/code/.nexus-outline-insertion-evidence-20261108`:
`android-uiautomator-original/dump137-{guest,events}.log` and original run
`20261108-200610-1e655ee9aeb2/artifacts/outline-native-{failure-native.txt,final.png,release.json}`.
the temporary native checkout has been removed. resolved when the
existing owned adb/uiautomator invocation reliably completes cleanly, or its
upstream teardown defect has an explicit qualified observation contract.

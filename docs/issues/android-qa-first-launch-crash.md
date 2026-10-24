# android framework crash on qa launch

a freshly installed isolated qa apk crashed during application binding on the
connected samsung sm-s906w, android 36. no application frame appears in the stack.
the driver could not attach to the process; this run did not qualify app behavior.

evidence: offline catalog merge run `20261023-174959-06a67f0288d7`, source
`4cc46e62e`, package `app.nexus.android.offlinecatalogmergeqa`, pid 26478.
the device crash buffer reports `NullPointerException` calling
`Resources.getConfiguration()` from
`ConfigurationController.updateLocaleListFromAppContext:290`, then
`ActivityThread.handleBindApplication:8591`. the installed production/debug
versions and installation timestamps were unchanged after cleanup.

reproduce with an isolated fresh install and launcher intent; retain launcher
output and native crash logs before uninstalling. determine whether device
package/resources initialization or application configuration triggers the null
context. no cause or workaround is established. a later successful launch alone
does not resolve this issue; identify the cause and verify the responsible fix.

# android hierarchy dump rejected after reporting output

on feedback source `cd7d935b`, owned api34 run
`20261103-164239-fdc0994c92aa` rejected `adb -s emulator-5620 shell
uiautomator dump --compressed` before the first player tap. stdout said
`UI hierchary dumped to:` followed by the run-owned xml path; stderr was empty.
no tap was sent. the app remained alive and idle, and exact package, mappings,
serial and canonical services were retired normally.

the temporary command wrapper discarded the exit code, signal, killed flag
and elapsed time. its cleanup removed the owned xml before a failed command's
output could be inspected. neither a timeout, exit 137 nor a valid hierarchy
was established; the reported filename alone does not establish success.
there is no evidence connecting this failure to the separate emulator-exit
or adb-transport issues.

on source `c7c412c8`, run `20261103-173350-395a88e80da0` retained two
later outcomes: exit 137, null signal, killed false, empty stderr and the same
completion line after 1140 and 1133ms. each owned file held a complete 762-byte
hierarchy with the app's webview at `[0,128][1080,2337]`. neither file was used
for input. these observations do not establish the earlier failure's code,
the cause of exit 137, or that abnormal retirement is harmless.

impact: a native input check can stop before exercising product behavior.

run `20261112-185348-5c6baa510880`, based on `a36bf6d9a`, hit the same
command-rejection stage before attachment. its temporary wrapper again retained
only the error string and removed the owned xml; exact exit/signal/timeout and
file validity cannot be recovered. owned-pid logcat shows no application fatal
exception; a requested java dump completed into tombstoned. neither observation
identifies the rejected dumper's cause. package, mappings and emulator cleanup
completed without reported errors.

validate the fresh owned hierarchy independently of command completion: the
api34 reference dumper catches write errors, so even exit zero and completion text do not
prove a complete file. keep abnormal command status distinct from validated
query data; reject stale, malformed, foreign or ambiguous geometry. retain
exact outcomes and actual touch postconditions. resolve by identifying the
rejected command's cause and verifying reliable real-device input through the
corrected owner. a later successful journey alone does not explain it.

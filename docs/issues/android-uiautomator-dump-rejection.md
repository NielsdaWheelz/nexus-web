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

impact: a native input check can stop before exercising product behavior.
retain the command outcome and bounded owned xml on recurrence, without
accepting a failed dump or guessing touch coordinates. resolve by identifying
the rejected command's cause and verifying reliable real-device input through
the corrected owner. a later successful journey alone does not explain it.

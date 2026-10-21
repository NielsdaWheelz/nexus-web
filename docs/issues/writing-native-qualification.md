# native writing qualification

the current writing cutover still needs actual android composition across first
publication and a completed recovery-file export before purge. acceptance is
incomplete. the isolated samsung sm-s906w/android 16/webview 155 run restored the
rich 50,000-codepoint checkpoint after process death, but exposed no accessible
keyboard keys. observed key geometry is available for a real-key rerun.

the export driver also awaited webview work while the system picker paused it
(`MainActivity.kt:491`). repair that temporary driver to operate the picker
concurrently, preserving cancellation, exact rich-file and completion-before-purge
assertions. the stopped run restored gboard and removed all owned device resources.

resolved when the exact built source passes both real journeys, with no synthetic
composition or fabricated native completion. final signed/optical acceptance in
`notes-writing-android-acceptance-blocked.md` remains separate.

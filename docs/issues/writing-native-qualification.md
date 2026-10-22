# native writing qualification

the current writing cutover still needs actual android composition across first
publication and a completed recovery-file export before purge. acceptance is
incomplete. the isolated samsung sm-s906w/android 16/webview 155 run restored the
rich 50,000-codepoint checkpoint after process death. observed keyboard geometry
now delivers real samsung input. native trusted composing input and committed
input were captured; the end event itself was untrusted. the passive observer
uses actual trusted input state and retains every event's trust flag. run17 kept
the same focused editor, native selection and ongoing composition through the
real first-page acknowledgement, then continued and committed native input.
the journey stopped before convergence because blank-title publication caused a
false conflict; it also exposed premature preedit checkpoints. their owning
records are `writing-page-default-title.md` and `writing-ime-preedit-admitted.md`.

the export driver also awaited webview work while the system picker paused it
(`MainActivity.kt:491`). repair that temporary driver to operate the picker
concurrently, preserving cancellation, exact rich-file and completion-before-purge
assertions. that temporary repair awaits completion. stopped runs restored gboard
and removed all owned device resources.

resolved when the exact built source passes both real journeys, with no synthetic
composition or fabricated native completion. final signed/optical acceptance in
`notes-writing-android-acceptance-blocked.md` remains separate.

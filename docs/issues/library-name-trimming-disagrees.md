# library name trimming disagrees

the chooser can offer a name that the server trims into a reserved or empty name.
`apps/web/src/lib/libraries/views.tsx:13` uses javascript `trim()`; the server's
`python/nexus/services/libraries.py:166` uses python `strip()`. for example,
`\u0085All\u0085` retains its boundary characters in javascript but becomes `All`
in python, so the client offers creation and the server refuses it.

this is a source finding at `f47dee6c2`; the ui journey has not been run. align the
boundary-character contract in both owners and verify a real chooser submission
at the boundary. no import-specific normalization or validation branch is needed.

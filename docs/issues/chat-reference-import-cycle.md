# standalone chat reference import cycle

direct service composition can fail before reference body resolution. live lab
`20261112-194021-ab28cff37668` reached `chat/references.py:221`, then imported
`chat/timeline.py:14` → `chat/reads.py:47` → `tools/presentation.py:27` →
`tools/reads.py:38`, which requests `MessageReadRefusal` from the still-initializing
timeline module. python raises `ImportError: cannot import name
'MessageReadRefusal' from partially initialized module 'nexus.services.chat.timeline'`.

reproduce in the configured python environment by importing
`nexus.services.chat.references` before `nexus.services.chat.timeline`, or by calling
`references.resolve` from a standalone service driver without first initializing
`chat.reads`. normal api composition and the earlier full13 driver initialize the
read module first. the temporary merge witness now uses that same composition;
the underlying dependency cycle remains unfixed.

resolve when these public chat service modules initialize independently without
preloading another module to avoid the cycle, while existing timeline, tool and
reference behavior remains intact. no production dependency rewrite belongs to
the companion merge.

# the attachable capability has no reader

found by source review on 2026-11-12; still present at `6fc320a75`.
`Capability.attachable` in `python/nexus/services/resource_items/capabilities.py`
is declared and set false for two kinds, but has no reader in `python/nexus`.
the chat admission owner therefore does not enforce this declared capability.

this is distinct from visibility: `python/nexus/services/chat/references.py`
checks current reference visibility before exposing context, returning
`source unavailable` when it cannot. no content-disclosure bypass was established.

resolve by enforcing the intended kind-level admission rule at chat admission,
or removing the unused capability. preserve the existing visibility checks.

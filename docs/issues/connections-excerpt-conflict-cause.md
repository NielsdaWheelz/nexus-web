# excerpt conflict claims a change without proof

problem: a remote full-excerpt read maps every `E_RESOURCE_CONFLICT` to `this excerpt has changed.` and `show new version`.

impact: database contention falsely reports changed text and offers accepting a new capture instead of retrying the retained one.

source: frozen `72cf9db84efc47966a09cc888309b013228fa3b9`; `apps/web/src/components/resources/ExcerptDisclosure.tsx:56-57,97`; `python/nexus/api/edge.py:93-99` emits the same code for `DatabaseBusyError`. the actual capture mismatch is `python/nexus/services/resource_items/items.py:337-343`; the wire does not distinguish it.

resolution: preserve `this excerpt has changed.` only for the local revision comparison at line66. for the generic remote code, proposed fact `couldn’t load the full excerpt.` with no cause; retain an explicit `retry` and, if needed by the existing capture flow, `show current excerpt`. no message parsing or new wire code. prove contention never claims changed text and true capture mismatch remains recoverable.

status: source finding only; no runtime journey run. correction and behavior qualification remain pending.

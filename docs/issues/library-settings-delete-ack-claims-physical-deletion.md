# settings overstates a masked delete acknowledgement

problem: when changed name text keeps library settings open after delete returns204,
its fact says the library is deleted. that endpoint also acknowledges invisible
absence after membership loss, while another member may still access the library.

source: `apps/web/src/components/LibrarySettingsDialog.tsx:189` at repair704471a03;
`python/nexus/services/libraries.py:337-339` returns from masked NotFound without
physical deletion. the204 settles this endpoint operation, not physical existence.

fix the existing fact to say this library is unavailable, retaining the unsaved
name and the current acknowledgement/guard contract. no server protocol change.

resolved when a real masked204 with changed name text leaves a truthful fact and
copyable draft, while the peer still reads the library, in both browsers.

observed in both engines at704471a03 with real DELETE204 and peer GET200;
the changed draft keeps the false physical-deletion claim visible. repair and
independent review remain pending.

# hidden primary post blocks its thread reader

a viewer tombstone on a primary canonical x post makes the private containing
thread reader unavailable. the thread itself may remain readable/searchable.
the repair fails closed rather than showing hidden words or labelling a local
privacy choice as unavailable on x.

evidence: `python/nexus/services/reader_document.py:251` applies the shared
readable-media relation; line 406 raises `E_MEDIA_NOT_FOUND` when any primary
source is excluded. `python/nexus/auth/permissions.py:231` excludes the child
tombstone without removing its independently filed thread root.

reproduce: import a thread, hide one canonical primary post for its viewer,
then open the still-filed thread. contextual posts are omitted independently;
primary posts currently refuse the complete private projection.

resolved when an explicit local-hidden-post reader state preserves the thread
composition without exposing its body, inventing provider status, or changing
source offsets. qualify saved positions and export/access rules for that state.

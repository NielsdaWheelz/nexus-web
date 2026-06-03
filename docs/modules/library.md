# Libraries

Libraries organize access to content; they do not own media ingestion or asset
delivery.

`python/nexus/services/libraries.py` owns library membership, entry assignment,
default-library closure, invites, and ownership transfer. Media capabilities call
library services to attach or validate visibility, then return to their own
owners for ingestion, playback, files, or assets.

## Composition Rules

- URL ingest validates requested library IDs once at the dispatch boundary.
- Source owners (`x_ingest.py`, `youtube_ingest.py`, `remote_file_ingest.py`,
  web-article creation) attach resulting media through library services.
- Library entries never make a private media file public.
- Public owned Oracle plates are not library resources; readings may reference
  them, but the plate asset route is owned by `oracle_plates.py`.
- Default-library closure affects visible media rows, not object-storage keys.

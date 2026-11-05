# the destination catalog can falsely say no libraries exist

`DestinationChooser.tsx:80` says `no libraries yet.`, but `python/nexus/services/libraries.py:506–526` returns only named admin destinations. a member can have libraries while having none writable through this chooser.

use one truthful empty-state sentence at the shared chooser. resolve with a real member who has a non-admin library and no writable named destination, across import and placement, preserving popup consistency. an empty fresh account or the fixed All explanation does not exercise this distinction.

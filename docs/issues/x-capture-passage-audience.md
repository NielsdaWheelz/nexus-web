# x capture passage audience

`media_passages` promises that `admitted_reading_media_ids=[]` admits no media passage, but its x capture query in `python/nexus/services/resource_items/locations.py` filters only account readability and an optional per-ref preferred reading. it ignores the supplied audience. an authorized immutable capture outside a requested reading scope can therefore be returned by this function.

existing search callers in `python/nexus/services/search/sources.py` pass audience lists for media-owned passage anchors, so no exposed x caller has been established. fix the existing x query by requiring a selected structural occurrence in the supplied audience, while retaining account capture readability. resolution: an empty audience returns no x passage; an unrelated reading returns none; an admitted containing reading returns the same frozen capture.

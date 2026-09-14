status: open
origin: 2026-09-13 bounded workspace implementation
area: retained reader contents

the retained index packs every unit before sections and toc (`python/nexus/services/reader_publication_artifacts.py:414`). a large publication can therefore require many pages with no navigable contents before its first toc row. the browser cannot hydrate the whole index to construct the old contents tree.

first agree the explicit retained contents read boundary with the publication and native owners. use existing target ids and bounded pages; preserve exact source targets and full reachability. no hidden whole-index accumulation or empty-page traversal in the contents UI.

done when a large publication opens its first contents page with navigable source entries, subsequent pages reach all entries, and content-unit count does not determine the number of empty contents pages.

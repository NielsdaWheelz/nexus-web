# passage labels can split a grapheme

`python/nexus/services/resource_items/items.py:passage_label` slices an already
safe excerpt with `selection.text[:120]`. that new codepoint cut can bisect a
joined emoji: `"ab" + "👩‍💻" * 50`. identity and activation are unaffected;
the displayed label can change the final character's appearance.

resolve with grapheme-aware label clipping at this owner and verify the label
remains a literal prefix within its budget. broader label policy is outside the
current excerpt-window and retrieval integration slice.

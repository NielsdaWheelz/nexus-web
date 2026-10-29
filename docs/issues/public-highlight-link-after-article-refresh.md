# public highlight link becomes unavailable after article refresh

at `9c74ceef5`, an ordinary article paragraph highlight's public link returns
404 after the article publisher replaces its fragment, even though the exact
paragraph survives. private article reading returns 200 with the new quote.

observed in disposable run `20261028-143326-f3ec6f34cdfb` in the native
qualification checkout: `api.log:38,40` records the same public link reading
200 before refresh; `api.log:42-43`, request
`b185cb30-1891-491f-a293-f0d8996c71b7`, records `E_NOT_FOUND: Share unavailable`
after `publish_prepared_article` republishes the unchanged paragraph with a
new quoted excerpt. the highlight was created through authored changes and
shared through the real share endpoint; no client repair ran after refresh.

`public_resource_sharing._highlight` requires
`locator_resolver.resolve_highlight_reader_target`, whose persisted fragment
anchor still names the replaced fragment. this is separate from the missing
public highlight capture-manifest extension; qualification of that boundary
uses quote completion without replacing the paragraph fragment.

resolved when the same public highlight link remains readable after a real
article refresh preserving its uniquely matching paragraph, without requiring
an authenticated reader to repair the anchor first. ambiguous or removed
text must retain explicit unresolved behavior. reader ownership needs review;
no reader changes are included in the manifest fix.

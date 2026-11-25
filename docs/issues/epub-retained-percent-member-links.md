# some old stored epub urls cannot identify a literal percent

an already published fragment can contain a raw href such as `a%41.xhtml`
for an archive member with that literal name. the encoded url for that member
is `a%2541.xhtml`. current readers decode the url path once. the old href is
therefore ambiguous and can fail to navigate. none of the 397 local inputs
in the 2026-11-23 census has a literal percent in a member name.

reproduce with an original whose member uses a literal percent escape and an
old retained fragment storing the raw path. reprocess the source into the
current url format with retained targets verified. test the ordinary links
and exact note relationships in the resulting hosted and downloaded reader.

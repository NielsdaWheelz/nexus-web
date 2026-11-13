# reference quote republication on a text part

the reference-quotes specification q5 asks for relocation after a text part’s
source republishes. the current source owner refuses republication while any
part pins it (`python/nexus/services/media_parts.py:121-130`;
`reader_publication.py:167-171`). bypassing that invariant would fabricate a
passing journey and invalidate the part’s generation proof.

impact: the specified part-republication transition needs an admitted production
command before it can be qualified. ordinary part capture, authority and source
republishing without a pin can be checked independently.

resolved when an existing admitted composition transition demonstrates the intended
stale-part behavior, or the owner narrows q5 to transitions the product permits.

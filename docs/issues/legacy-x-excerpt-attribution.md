# legacy x excerpt attribution

before this change, x blockquote extraction copied attribution/permalink text into
excerpt bodies. a metadata-only embed could therefore retain a date as captured
text. new extraction separates this metadata; existing immutable captures and
backfilled observations retain their original text.

evidence: `document_embed_extraction.py` at `41b6872a1:146–185` copied the whole
inner html; `0333_source_citations.py:_captured_evidence` freezes the retained
article excerpt. the controlled nonempty-permalink case reproduced a captured
body instead of an unknown reference before the extractor fix.

normalization can erase the original body/attribution boundary. do not strip text
by title, url or date guesses. if affected live captures exist, repair them only
from their retained original article packet and explicit occurrence proof, using
the current publication contract; preserve already stored citation observations.

resolved when live inspection finds no affected current excerpts, or every
proved affected occurrence is republished from retained source evidence and its
citation/navigation is verified. no network reconstruction of historical text.

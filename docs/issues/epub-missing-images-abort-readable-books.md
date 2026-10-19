# missing epub images abort book imports

status: open
origin: 2026-09-26 exact-source processing investigation
area: epub extraction / source quality

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` has four failed imports:
toll the hounds `aa4dee6d-2d77-4541-93a2-01dc60a1ac93`, odyssey/fitzgerald
`c7f9c508-d91f-4aa2-9c20-935af07a8c5e`, persuasion
`a9ddec14-f96d-45ba-b420-9e7824e53c6f`, sense and sensibility
`9378ff1b-bde9-4896-86f4-c28a3e857933`.
`services/epub_ingest.py:1111-1127` aborts on an image absent from the opf
manifest. exact original r2 objects were downloaded read-only and matched
stored sha256/size. archive census found genuinely absent bytes: 20 references
in toll, and one missing cover in each other book. this is not merely a
manifest lookup bug. private receipts: `/tmp/nexus-processing-review-20260926/`.

separate archive security/structural validity from missing presentation assets.
preserve original bytes, render honest missing-image placeholders where useful,
and retain an explicit incomplete-source warning. never synthesize illustrations
or silently claim complete fidelity. inspect toll's missing-image context before
deciding whether its missing material requires a replacement edition.

all four archives retain a separately declared cover image. the three broken
cover chapters point to other absent paths; do not assume they equal the
declared cover. toll's eight large frontmatter images cannot be identified
from the remaining bytes; two later floated images appear to contain missing
initial letters, an inference from adjacent prose. completeness needs a better
source, not invented images or letters.

acceptance: all four sources have truthful outcomes; available text and existing
images survive; absent images remain disclosed; traversal, decompression,
resource and essential-structure checks remain strict. retry admission must
allow a diagnosed correction without erasing the historical failure.

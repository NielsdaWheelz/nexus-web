# end-clamped jump can retain the previous section label

status: open
baseline: `d9e7d86aa5659568eb592e0fe89f167fd0596634`

a jump near a short document ending reaches its destination but can leave the
chapter control on an earlier section. with a 1001-section epub and short final
passage, a wide 900px reader targeting section 1000 displayed 999; next from 1000
could retain 1000 instead of displaying 1001. baseline and first-green private
logs are in `/var/folders/cb/dy22pnwn5_9c_rzxkbzymbm00000gn/T/nexus-reader-section-toolbar-x_rosck4/`.

evidence: `apps/web/src/lib/documentReader/text/geometry.ts:247-255` measures the
reading line; lines 288-303 accept end-clamped arrival.
`apps/web/src/lib/documentReader/model.ts:269-272` derives the section from that
measured point. the final passage cannot reach the reading line when less than
one viewport remains. reader-toolbar layout does not change this policy.

resolved when: define the current-section contract for end-clamped arrivals and
qualify short final sections, jumps, repeated previous/next, reflow and natural
scrolling at that owner. preserve canonical coordinates and held reading state;
do not guess a chapter from visible title text.

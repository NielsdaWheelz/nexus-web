# a cold worker image blocks unrelated warm consumers

at fetched main `aa3dfc0863e24e91db8c2bdebc7a4ba2cdb5e306`,
`python/scripts/worker_checkout_image.py:76-190` holds one host-wide lock over
inspection, a cold build bounded at 1200 seconds, consumer container creation
and cache retention. a caller whose dependency image already exists must wait
for another dependency hash's build (`80-96`). contention duration has not been
measured in this investigation.

the lock currently protects a real invariant: containers pin an acquired image
before retention can remove its tag (`129-136`). removing or splitting the lock
without preserving that acquisition boundary would introduce a deletion race.

if measured contention warrants the added synchronization, separate same-image
build ownership from the short pin-and-retention boundary and bounded cold-build
admission. resolved when a warm consumer can start during an unrelated cold
build, same-key callers avoid duplicate builds, and retention cannot invalidate
an acquisition in progress.

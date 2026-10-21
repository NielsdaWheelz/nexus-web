# a second remote body change misses the receive budget

at `3942b8fd2`, private run `20261021-124029-3695898bc692` first browser case:
the remote editor receives the origin's autosave, then remains at that value after
a real independent `set_body` succeeds with version 2 expectation. the next body
does not become visible within the required two seconds.

inspect the actual stream/probe/body-read/adoption sequence; repair its responsible
owner without broad invalidation or a larger timeout. resolved when consecutive
independent writes reach the mounted remote editor within the receive budget and
do not reread unrelated outlines.

diagnosis: the version-3 canonical body arrives within 50 ms. `texts.ts` accepts
raw jsonb object key order, then journal base adoption normalizes through the
existing rich parser. raw `{text,type}` and canonical `{type,text}` fail its
stringified canonical equality, falsely marking an untouched body dirty and
rejecting the next read. normalize at text ingress; keep dirty protection intact.

# pending history exposes an obsolete placement as a second alias

external `f50e52f5a` inline-page history produces two distinct row ids for the
same page. scoped candidate `c19992566` still fails at undo-outdent in
`20261026-054735-129c8187d7d8`: one occurrence remains nested and another
appears at the root before the following text undo. prior text/order premises
pass. this is a presentation failure; canonical relation corruption or writing
loss has not been established.

`OutlineController.prepare` can overwrite an outstanding withdrawal, and its
logical source parent can already be root while `row.link` still describes the
old parent until its promise resolves. a committed-link id is not reliable
placement identity during that interval. retain exact occurrence/semantic-pair
ownership without a lookup fallback or a duplicate-stripping render pass.

resolve with immediate indent/outdent/undo and text history, retaining one
intended occurrence, exact canonical relations/text, repeated-appearance controls
and same native editing host. the same-parent-only source correction is not yet
a green qualification.

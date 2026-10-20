# real message verification needs generation admission

owner decision, 2026-10-19: message live verification is waived for this change.
retain this gap for later qualification; it is not a message behavior failure.

problem: the isolated runtime has no selectable generation route, so the public
chat admission cannot create a real message fixture. conversation children pass;
message children remain unverified.

evidence: run `20261019-215430-56a1494e6bbe`, temporary acceptance case 4 skipped
after reading the real `/llm-catalog`. only `services/chat/admit.py:414,427`
construct messages; generation selection is checked before that transaction.
there is no public provider-free message creation route.

an explicitly supplied openai configuration was attempted in runtime
`20261019-224140-6d3f71ae9163`. catalog admission remains unavailable because the
real codex snapshot is a global prerequisite; see
[catalog owner](local-generation-catalog-qualification-blocked.md).

prerequisite: real native-catalog support for isolated verification. the case
cancels immediately after admission and requires no assistant answer;
generation may begin before cancellation. no fabricated messages or provider replies.

resolved when a real admitted message owns an editable child through the shared
browser surface, preserving its original message content.

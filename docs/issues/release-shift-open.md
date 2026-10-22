# shift-open release

production api and hosted web `99320b630` shipped together on 2026-10-22,
schema 0306 and wire 13. the paired `android-v0.3.5` is published and installed.

- migration 0296 drops oracle's admission-key column/index and reading-id server
  default. existing ids, folios, content, statuses, citations and jobs survive.
  downgrade is unsupported. the complete migration chain passed on the fresh
  stopped-writer backup restore and in production.
- the paired clients use the new backend contract: oracle creation requires `{id,
  question}`; context-chat creation requires `{id, initial_context_refs}`;
  the chat active-path API is removed. do not pair old web clients
  with the cutover backend.
- the released contract is wire 13; stale clients must update.
- saved chats and messages survived the cutover. workspace hrefs without a leaf
  seed once from the last admitted send branch.

deployment is complete. live shift-open and ordinary-open smoke checks remain
`NOT_RUN`; delete this record when those checks pass on the paired release.

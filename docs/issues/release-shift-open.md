# shift-open release

coordinated web/backend cutover; no deployment is part of this change.

- migration 0295 drops oracle's admission-key column/index and reading-id server
  default. existing ids, folios, content, statuses, citations and jobs survive.
  downgrade is unsupported. follow the deployment controller's stopped-writer,
  verified-backup, ancestry and exact-head requirements before applying.
- ship regenerated clients with the backend: oracle creation requires `{id,
  question}`; context-chat creation requires `{id, initial_context_refs}`;
  the chat active-path API is removed. do not pair old web clients
  with the cutover backend.
- wire stays 12: the first breaking change after android 0.3.4 already bumped
  11 → 12 (`9383a0545`). subsequent changes before that release share the bump.
- per-pane chat drafts use `nx_chat_draft:`. older browser convenience drafts are
  intentionally unread; saved chats/messages are unchanged. workspace hrefs
  without a leaf seed once from the last admitted send branch.

resolved when the paired release reaches migration 0295 and wire 12, then live
shift-open and ordinary-open smoke checks pass on that release.

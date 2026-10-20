# release chat citation publication

status: owed at the next release

deploy the api, web renderer and chat worker together. an old api can still
emit the removed tour action to a new web action catalog. the worker image must
include the generated `nexus/services/chat/markdown_citations.mjs` bundle and its existing
pinned node runtime. `gen:chat-citations` freshness is part of `./scripts/test`.
the api contracts only lose the optional tour action; no new wire bump or
database migration is required.

in-flight runs retain their frozen prompts and publish through the new grammar.
unknown references still use the existing warning. existing message contents and
edges are not rewritten; historical integrity remains a separate audit.

owner smoke: a new cited answer preserves code indexes; inline previews retain
captured evidence; ordinary and shifted source opening work on desktop/mobile;
message menus contain no walkthrough. remove this record after the paired
release and smoke.

# deleting a chat leaves its authored context links on devices

chat context links with a `conversation:` endpoint are canonical authored links
(owner decision). deleting a conversation runs machine-fact cleanup
(`python/nexus/services/resource_graph/cleanup.py`), which by contract never
removes authored links. the link stays live in `authored_links`, its projection
row stays in `resource_edges`, and devices keep it with the conversation's
captured source-stub label.

impact: a note's local adjacency/backlinks can show a row for a chat that no
longer exists. server readers hide it (the conversation no longer resolves), so
there is no data or access leak; it is presentation residue.

options: unlink every authored link incident to the chat through
`services.authored.server_command` inside chat deletion (observed coverage,
after the chat lock and before nothing else), or keep the stub row as a literal
reference.

resolved when the owner picks one, and deleting a chat on the server produces
the chosen device-visible result after sync.

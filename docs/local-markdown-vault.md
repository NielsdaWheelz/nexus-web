# Local Markdown Vault

Local Vault is a browser-managed Markdown projection of server-owned Nexus data.
The user picks a real local folder in `Settings -> Local Vault`, Nexus writes the
vault there, and later refreshes that same folder by reading local edits from
`Highlights/` and `Pages/` and then rewriting the full snapshot.

## Product Flow

1. Open `Settings -> Local Vault`.
2. Click `Connect folder` and choose a writable local directory.
3. Click `Export vault` to write the initial snapshot.
4. Edit `Highlights/*.md` and `Pages/*.md` locally in Codex, Obsidian, or another editor.
5. Click `Sync now`, or enable auto-sync so Nexus refreshes on app load and when the tab becomes active again.

The browser remembers the directory handle locally. The actual vault remains a
normal filesystem folder.

## Contract

- `Library.md`, `Media/`, and `Sources/` are generated from server state.
- `Media/` and `Sources/` are rewritten on every export/sync.
- `Sources/` files are immutable local mirrors. Do not edit them.
- `Highlights/*.md` are editable and sync back to the server.
- `Pages/*.md` are editable and sync back to the server.
- Missing files do not delete server data.
- Deletes require `deleted: true` in frontmatter.
- Server timestamps and `last_synced_sha256` detect conflicts.
- Conflicts write sibling `*.conflict.md` files and skip that local mutation.

## Layout

```text
nexus-vault/
  Library.md
  Media/
  Sources/
  Highlights/
  Pages/
```

## Highlight Files

Existing highlights have a `highlight_handle`.

```markdown
---
nexus_type: "highlight"
highlight_handle: "hl_..."
media_handle: "med_..."
selector_kind: "text_position"
fragment_handle: "frag_..."
start_offset: 10
end_offset: 20
color: "yellow"
server_updated_at: "..."
last_synced_sha256: "..."
deleted: false
exact: "selected text"
prefix: "before "
suffix: " after"
---
Editable note body.
```

New web and EPUB highlights use `selector_kind: "text_quote"` with `media_handle`,
`exact`, and optional `prefix` and `suffix`.

New PDF highlights use `selector_kind: "pdf_text_quote"` with `media_handle`,
`page`, and `exact`. The server only creates the highlight when the quote resolves
uniquely on that page.

## Page Files

```markdown
---
nexus_type: "page"
page_handle: "page_..."
title: "My Note"
server_updated_at: "..."
last_synced_sha256: "..."
deleted: false
---
Editable Markdown body.
```

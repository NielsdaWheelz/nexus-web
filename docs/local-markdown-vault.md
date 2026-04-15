# Local Markdown Vault

The local vault is an editable Markdown projection of server-owned Nexus data.

## Commands

```bash
nexus vault export ./nexus-vault --user <user-uuid>
nexus vault sync ./nexus-vault --user <user-uuid>
nexus vault watch ./nexus-vault --user <user-uuid>
```

## Contract

- `Media/` and `Sources/` are rewritten from server state.
- `Sources/` files are immutable local mirrors. Do not edit them.
- `Highlights/*.md` are editable.
- `Pages/*.md` are editable.
- Missing files do not delete server data.
- Deletes require `deleted: true` in frontmatter.
- Server timestamps and `last_synced_sha256` detect conflicts.
- Conflicts write `*.conflict.md` and skip the local mutation.

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

New web/EPUB highlights should use `selector_kind: "text_quote"` with
`media_handle`, `exact`, and optional `prefix`/`suffix`.

New PDF highlights should use `selector_kind: "pdf_text_quote"`, `media_handle`,
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

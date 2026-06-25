from uuid import UUID

import pytest

from nexus.services.vault_contracts import (
    EditableVaultFile,
    ExistingHighlightFile,
    NewPageFile,
    VaultFileParseFailure,
    parse_editable_vault_path,
    parse_vault_markdown_file,
)

pytestmark = pytest.mark.unit

MEDIA_ID = UUID("11111111-1111-1111-1111-111111111111")
FRAGMENT_ID = UUID("22222222-2222-2222-2222-222222222222")
HIGHLIGHT_ID = UUID("33333333-3333-3333-3333-333333333333")
PAGE_ID = UUID("44444444-4444-4444-4444-444444444444")


def test_parse_editable_vault_path_accepts_only_canonical_editable_files():
    assert parse_editable_vault_path("Pages/note.md") == "Pages/note.md"
    assert parse_editable_vault_path("Highlights/note.md") == "Highlights/note.md"

    for path in (
        " Pages/note.md ",
        "/Pages/note.md",
        r"Pages\note.md",
        "Pages/sub/note.md",
        "Pages/../note.md",
        "Pages/.md",
        "Pages/note.conflict.md",
        "Library.md",
    ):
        with pytest.raises(ValueError):
            parse_editable_vault_path(path)


def test_parse_new_page_requires_explicit_title():
    parsed = parse_vault_markdown_file(
        EditableVaultFile(
            path="Pages/new.md",
            content="""---
nexus_type: "page"
title: "New Page"
deleted: false
---
Body.
""",
        )
    )

    assert isinstance(parsed, NewPageFile)
    assert parsed.title == "New Page"
    assert parsed.body == "Body.\n"


def test_parse_new_page_without_title_is_failure():
    parsed = parse_vault_markdown_file(
        EditableVaultFile(
            path="Pages/new.md",
            content="""---
nexus_type: "page"
deleted: false
---
Body.
""",
        )
    )

    assert isinstance(parsed, VaultFileParseFailure)
    assert parsed.message == "Vault page metadata is missing title"


def test_parse_existing_page_requires_path_handle_match_and_server_timestamp():
    missing_timestamp = parse_vault_markdown_file(
        EditableVaultFile(
            path=f"Pages/page--page_{PAGE_ID.hex}.md",
            content=f"""---
nexus_type: "page"
page_handle: "page_{PAGE_ID.hex}"
title: "Existing Page"
deleted: false
---
Body.
""",
        )
    )
    mismatched_handle = parse_vault_markdown_file(
        EditableVaultFile(
            path=f"Pages/page--page_{PAGE_ID.hex}.md",
            content="""---
nexus_type: "page"
page_handle: "page_55555555555555555555555555555555"
title: "Existing Page"
server_updated_at: "2026-06-20T00:00:00+00:00"
deleted: false
---
Body.
""",
        )
    )

    assert isinstance(missing_timestamp, VaultFileParseFailure)
    assert missing_timestamp.message == "Vault page metadata is missing server_updated_at"
    assert isinstance(mismatched_handle, VaultFileParseFailure)
    assert mismatched_handle.message == "Vault page handle does not match path"


def test_parse_existing_highlight_requires_required_metadata_without_defaults():
    new_with_existing_field = parse_vault_markdown_file(
        EditableVaultFile(
            path="Highlights/new.md",
            content=f"""---
nexus_type: "highlight"
media_handle: "med_{MEDIA_ID.hex}"
color: "yellow"
deleted: false
exact: "quote"
selector_kind: "fragment_offsets"
fragment_handle: "frag_{FRAGMENT_ID.hex}"
start_offset: 1
end_offset: 6
---
Note.
""",
        )
    )
    new_with_pdf_selector = parse_vault_markdown_file(
        EditableVaultFile(
            path="Highlights/new-pdf.md",
            content=f"""---
nexus_type: "highlight"
media_handle: "med_{MEDIA_ID.hex}"
color: "yellow"
deleted: false
exact: "quote"
selector_kind: "pdf_text_quote"
page: 1
---
Note.
""",
        )
    )
    missing_color = parse_vault_markdown_file(
        EditableVaultFile(
            path=f"Highlights/hl_{HIGHLIGHT_ID.hex}.md",
            content=f"""---
nexus_type: "highlight"
highlight_handle: "hl_{HIGHLIGHT_ID.hex}"
media_handle: "med_{MEDIA_ID.hex}"
server_updated_at: "2026-06-20T00:00:00+00:00"
deleted: false
exact: "quote"
prefix: ""
suffix: ""
selector_kind: "fragment_offsets"
fragment_handle: "frag_{FRAGMENT_ID.hex}"
start_offset: 1
end_offset: 6
---
Note.
""",
        )
    )
    parsed = parse_vault_markdown_file(
        EditableVaultFile(
            path=f"Highlights/hl_{HIGHLIGHT_ID.hex}.md",
            content=f"""---
nexus_type: "highlight"
highlight_handle: "hl_{HIGHLIGHT_ID.hex}"
media_handle: "med_{MEDIA_ID.hex}"
color: "yellow"
server_updated_at: "2026-06-20T00:00:00+00:00"
deleted: false
exact: "quote"
prefix: ""
suffix: ""
selector_kind: "fragment_offsets"
fragment_handle: "frag_{FRAGMENT_ID.hex}"
start_offset: 1
end_offset: 6
---
Note.
""",
        )
    )
    fragment_with_page = parse_vault_markdown_file(
        EditableVaultFile(
            path=f"Highlights/hl_{HIGHLIGHT_ID.hex}.md",
            content=f"""---
nexus_type: "highlight"
highlight_handle: "hl_{HIGHLIGHT_ID.hex}"
media_handle: "med_{MEDIA_ID.hex}"
color: "yellow"
server_updated_at: "2026-06-20T00:00:00+00:00"
deleted: false
exact: "quote"
prefix: ""
suffix: ""
selector_kind: "fragment_offsets"
fragment_handle: "frag_{FRAGMENT_ID.hex}"
start_offset: 1
end_offset: 6
page: 1
---
Note.
""",
        )
    )

    assert isinstance(new_with_existing_field, VaultFileParseFailure)
    assert new_with_existing_field.message == (
        "Vault new highlight metadata has unknown field exact"
    )
    assert isinstance(new_with_pdf_selector, VaultFileParseFailure)
    assert new_with_pdf_selector.message == "Vault highlight metadata has invalid selector_kind"
    assert isinstance(missing_color, VaultFileParseFailure)
    assert missing_color.message == "Vault highlight metadata is missing color"
    assert isinstance(parsed, ExistingHighlightFile)
    assert parsed.color == "yellow"
    assert parsed.server_updated_at == "2026-06-20T00:00:00+00:00"
    assert isinstance(fragment_with_page, VaultFileParseFailure)
    assert fragment_with_page.message == (
        "Vault highlight fragment_offsets metadata has unknown field page"
    )


def test_parse_rejects_missing_frontmatter_unknown_fields_and_oversized_content():
    missing_frontmatter = parse_vault_markdown_file(
        EditableVaultFile(path="Pages/new.md", content="Body.")
    )
    unquoted_string = parse_vault_markdown_file(
        EditableVaultFile(
            path="Pages/new.md",
            content="""---
nexus_type: page
title: "New Page"
deleted: false
---
Body.
""",
        )
    )
    unknown_field = parse_vault_markdown_file(
        EditableVaultFile(
            path="Pages/new.md",
            content="""---
nexus_type: "page"
title: "New Page"
deleted: false
surprise: "no"
---
Body.
""",
        )
    )
    oversized = parse_vault_markdown_file(
        EditableVaultFile(
            path="Pages/new.md",
            content=("é" * 500_000) + "a",
        )
    )

    assert isinstance(missing_frontmatter, VaultFileParseFailure)
    assert missing_frontmatter.message == "Vault file is missing frontmatter"
    assert isinstance(unquoted_string, VaultFileParseFailure)
    assert unquoted_string.message == (
        "Vault frontmatter field nexus_type must be a quoted string, boolean, integer, or block value"
    )
    assert isinstance(unknown_field, VaultFileParseFailure)
    assert unknown_field.message == "Vault page metadata has unknown field surprise"
    assert isinstance(oversized, VaultFileParseFailure)
    assert oversized.message == "Vault file content exceeds 1,000,000 UTF-8 bytes"

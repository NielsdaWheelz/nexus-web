"""Strict vault export traces for real media and saved highlights."""

from __future__ import annotations

import io
import zipfile
from uuid import UUID

import pytest

from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_export_trace,
    assert_media_ready,
    assert_saved_highlight_trace,
)
from tests.real_media.conftest import (
    capture_nasa_water_article,
    ensure_real_media_prerequisites,
    write_trace,
)
from tests.utils.db import DirectSessionManager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]


def test_real_web_article_vault_export_uses_content_blocks_and_highlight_selectors(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    media_id = capture_nasa_water_article(auth_client, direct_db, headers)
    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")

    fragments_response = auth_client.get(f"/media/{media_id}/fragments", headers=headers)
    assert fragments_response.status_code == 200, fragments_response.text
    fragment = fragments_response.json()["data"][0]
    start_offset = fragment["canonical_text"].index("SOFIA")

    highlight_response = auth_client.post(
        f"/fragments/{fragment['id']}/highlights",
        json={
            "start_offset": start_offset,
            "end_offset": start_offset + len("SOFIA"),
            "color": "green",
        },
        headers=headers,
    )
    assert highlight_response.status_code == 201, highlight_response.text
    highlight = highlight_response.json()["data"]
    assert highlight["exact"] == "SOFIA", highlight
    highlight_trace = assert_saved_highlight_trace(
        direct_db,
        media_id=media_id,
        highlight_id=UUID(highlight["id"]),
        expected_exact="SOFIA",
    )

    export_response = auth_client.get("/vault/download", headers=headers)
    assert export_response.status_code == 200, export_response.text
    assert export_response.headers["content-type"] == "application/zip"
    assert export_response.headers["content-disposition"] == (
        'attachment; filename="nexus-vault.zip"'
    )
    with zipfile.ZipFile(io.BytesIO(export_response.content)) as archive:
        files = [
            {"path": name, "content": archive.read(name).decode("utf-8")}
            for name in sorted(archive.namelist())
        ]
    export_trace = assert_export_trace(
        direct_db,
        media_id=media_id,
        highlight_id=UUID(highlight["id"]),
        files=files,
        expected_needle="SOFIA mission",
    )

    write_trace(
        tmp_path,
        "real-web-nasa-vault-export-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "media": media_trace,
            "evidence": evidence_trace,
            "highlight": highlight_trace,
            "export": export_trace,
        },
    )

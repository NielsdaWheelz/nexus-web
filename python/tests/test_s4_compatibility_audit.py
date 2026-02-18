"""S4 compatibility audit tests.

Deterministic introspection and lightweight runtime checks that verify
L3 contract stability across the S4 slice:
- Conversation/message list limits unchanged from S3 defaults.
- ConversationOut and HighlightOut additive-only evolution honored.

These are audit-only tests with no database setup.
"""

import inspect


def _get_query_default(func, param_name: str):
    """Extract the default value from a FastAPI Query parameter."""
    sig = inspect.signature(func)
    param = sig.parameters[param_name]
    default = param.default
    if hasattr(default, "default"):
        return default.default
    return default


def _get_query_constraints(func, param_name: str) -> tuple[int | None, int | None]:
    """Extract (ge, le) constraints from a FastAPI Query parameter's metadata."""
    sig = inspect.signature(func)
    param = sig.parameters[param_name]
    default = param.default
    ge_val = None
    le_val = None
    if hasattr(default, "metadata"):
        for m in default.metadata:
            if hasattr(m, "ge"):
                ge_val = m.ge
            if hasattr(m, "le"):
                le_val = m.le
    return ge_val, le_val


class TestConversationListLimitContract:
    """Verify /conversations list limit contract is unchanged."""

    def test_conversation_list_route_limit_contract_unchanged(self):
        """GET /conversations limit: default=50, bounds [1, 100]."""
        from nexus.api.routes.conversations import list_conversations

        default = _get_query_default(list_conversations, "limit")
        assert default == 50, f"Default changed to {default}"

        ge, le = _get_query_constraints(list_conversations, "limit")
        assert ge == 1, f"Min bound changed to {ge}"
        assert le == 100, f"Max bound changed to {le}"

    def test_message_list_route_limit_contract_unchanged(self):
        """GET /conversations/{id}/messages limit: default=50, bounds [1, 100]."""
        from nexus.api.routes.conversations import list_messages

        default = _get_query_default(list_messages, "limit")
        assert default == 50, f"Default changed to {default}"

        ge, le = _get_query_constraints(list_messages, "limit")
        assert ge == 1, f"Min bound changed to {ge}"
        assert le == 100, f"Max bound changed to {le}"


class TestConversationServiceLimitConstants:
    """Verify conversation service limit constants are unchanged."""

    def test_conversation_service_limit_constants_unchanged(self):
        """DEFAULT_LIMIT=50, MIN_LIMIT=1, MAX_LIMIT=100."""
        from nexus.services import conversations

        assert conversations.DEFAULT_LIMIT == 50
        assert conversations.MIN_LIMIT == 1
        assert conversations.MAX_LIMIT == 100


class TestResponseSchemaEvolution:
    """Verify response schemas are additive-only."""

    def test_conversation_out_required_fields_preserved(self):
        """ConversationOut has base fields and S4 additive fields."""
        from nexus.schemas.conversation import ConversationOut

        fields = set(ConversationOut.model_fields.keys())

        # Base fields (S3)
        base_fields = {"id", "sharing", "message_count", "created_at", "updated_at"}
        assert base_fields.issubset(fields), f"Missing base fields: {base_fields - fields}"

        # S4 additive fields
        s4_fields = {"owner_user_id", "is_owner"}
        assert s4_fields.issubset(fields), f"Missing S4 fields: {s4_fields - fields}"

    def test_highlight_out_required_fields_preserved(self):
        """HighlightOut has base fields and S4 additive fields."""
        from nexus.schemas.highlights import HighlightOut

        fields = set(HighlightOut.model_fields.keys())

        # Base fields (S2)
        base_fields = {
            "id",
            "fragment_id",
            "start_offset",
            "end_offset",
            "color",
            "exact",
            "prefix",
            "suffix",
            "created_at",
            "updated_at",
            "annotation",
        }
        assert base_fields.issubset(fields), f"Missing base fields: {base_fields - fields}"

        # S4 additive fields (PR-07)
        s4_fields = {"author_user_id", "is_owner"}
        assert s4_fields.issubset(fields), f"Missing S4 fields: {s4_fields - fields}"

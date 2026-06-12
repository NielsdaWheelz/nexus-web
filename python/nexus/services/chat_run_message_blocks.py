"""Block rendering for persisted chat message text."""


def message_document(role: str, content: str) -> dict[str, object]:
    text_value = content.strip()
    return {
        "type": "message_document",
        "blocks": []
        if not text_value
        else [
            {
                "type": "text",
                "format": "markdown" if role == "assistant" else "plain",
                "text": content,
            }
        ],
    }

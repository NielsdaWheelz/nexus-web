from __future__ import annotations

import base64

PROVIDER_API_NAMES = (
    "openai",
    "anthropic",
    "gemini",
    "moonshot",
    "openrouter",
    "deepseek",
    "xai",
)
TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY = base64.b64encode(bytes(range(32))).decode("ascii")

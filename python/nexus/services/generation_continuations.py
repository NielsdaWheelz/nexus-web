"""Seal provider continuation bytes for one exact successor model turn."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAX_GENERATION_CONTINUATION_BYTES = 16 * 1024 * 1024
GENERATION_CONTINUATION_ENVELOPE_VERSION = "GenerationContinuation.Aes256Gcm.V2"
_NONCE_BYTES = 12
_GCM_TAG_BYTES = 16


class GenerationContinuationAuthenticationError(Exception):
    """The sole terminal refusal for a mismatched or unauthentic continuation."""


@dataclass(frozen=True, slots=True)
class GenerationContinuationContext:
    """Associated-data identity for one exact provider successor."""

    generation_id: UUID
    source_turn_seq: int
    successor_turn_seq: int
    target_fingerprint: str
    codec_id: str
    policy_revision: str

    def __post_init__(self) -> None:
        if self.source_turn_seq < 1:
            raise ValueError("source_turn_seq must be positive")
        if self.successor_turn_seq != self.source_turn_seq + 1:
            raise ValueError("successor_turn_seq must immediately follow source_turn_seq")
        for label, value in (
            ("target_fingerprint", self.target_fingerprint),
            ("codec_id", self.codec_id),
            ("policy_revision", self.policy_revision),
        ):
            if not value.strip() or len(value) > 256:
                raise ValueError(f"{label} must be bounded nonblank text")


@dataclass(frozen=True, slots=True)
class SealedGenerationContinuation:
    """Opaque authenticated envelope; repr never renders sensitive bytes."""

    context: GenerationContinuationContext
    envelope_version: str
    nonce: bytes = field(repr=False)
    ciphertext: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if self.envelope_version != GENERATION_CONTINUATION_ENVELOPE_VERSION:
            raise ValueError("generation continuation envelope version is unsupported")
        if len(self.nonce) != _NONCE_BYTES:
            raise ValueError("generation continuation nonce must be 96 bits")
        if not (
            _GCM_TAG_BYTES
            <= len(self.ciphertext)
            <= MAX_GENERATION_CONTINUATION_BYTES + _GCM_TAG_BYTES
        ):
            raise ValueError("generation continuation ciphertext is outside its bound")


class GenerationContinuationCipher:
    """Single-key AES-256-GCM continuation owner with no compatibility reader."""

    __slots__ = ("_cipher",)

    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("generation continuation key must be exactly 32 bytes")
        self._cipher = AESGCM(key)

    def seal(
        self, *, canonical_continuation: bytes, context: GenerationContinuationContext
    ) -> SealedGenerationContinuation:
        if not canonical_continuation:
            raise ValueError("generation continuation must not be empty")
        if len(canonical_continuation) > MAX_GENERATION_CONTINUATION_BYTES:
            raise ValueError("generation continuation exceeds the 16 MiB codec bound")
        nonce = os.urandom(_NONCE_BYTES)
        return SealedGenerationContinuation(
            context=context,
            envelope_version=GENERATION_CONTINUATION_ENVELOPE_VERSION,
            nonce=nonce,
            ciphertext=self._cipher.encrypt(
                nonce, canonical_continuation, _associated_data(context)
            ),
        )

    def open(
        self,
        *,
        sealed: SealedGenerationContinuation,
        expected_context: GenerationContinuationContext,
    ) -> bytes:
        if sealed.context != expected_context:
            raise GenerationContinuationAuthenticationError(
                "generation continuation context authentication failed"
            )
        try:
            plaintext = self._cipher.decrypt(
                sealed.nonce, sealed.ciphertext, _associated_data(expected_context)
            )
        except InvalidTag as error:
            raise GenerationContinuationAuthenticationError(
                "generation continuation authentication failed"
            ) from error
        if not plaintext or len(plaintext) > MAX_GENERATION_CONTINUATION_BYTES:
            raise GenerationContinuationAuthenticationError(
                "generation continuation plaintext is invalid"
            )
        return plaintext


def _associated_data(context: GenerationContinuationContext) -> bytes:
    return json.dumps(
        {
            "codec_id": context.codec_id,
            "generation_id": str(context.generation_id),
            "policy_revision": context.policy_revision,
            "source_turn_seq": context.source_turn_seq,
            "successor_turn_seq": context.successor_turn_seq,
            "target_fingerprint": context.target_fingerprint,
        },
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()

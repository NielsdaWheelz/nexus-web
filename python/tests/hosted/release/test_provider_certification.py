import asyncio
import os
from datetime import datetime
from pathlib import Path

import httpx
from provider_runtime import CATALOG, Present, ProviderCredential, ProviderRuntime

from nexus.services.llm_profiles import PROFILES
from tests.hosted._provider_live import (
    OneAttemptPerOperation,
    atomic_evidence,
    base_evidence,
    certify_chat,
    embedding_call,
    non_generation_cost_usd_micros,
    transcription_call,
    usage_counts,
)

CALL_LIMIT = 9
COST_LIMIT_USD = 0.10
REASONING = {
    "openai": "none",
    "anthropic": "low",
    "gemini": "minimal",
    "moonshot": "low",
}
MAX_OUTPUT = {"openai": 32, "anthropic": 256, "gemini": 256, "moonshot": 256}
KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
}


def test_active_nexus_provider_surface_is_release_certified() -> None:
    assert os.environ["NEXUS_PROVIDER_CERTIFICATION"] == "1"
    accepted_at = datetime.fromisoformat(
        os.environ["NEXUS_FABLE_RETENTION_ACCEPTED_AT"].replace("Z", "+00:00")
    )
    assert accepted_at.tzinfo is not None
    evidence_path = Path(os.environ["NEXUS_PROVIDER_CERTIFICATION_EVIDENCE_PATH"])
    evidence = base_evidence(call_limit=CALL_LIMIT, cost_limit_usd=COST_LIMIT_USD)
    atomic_evidence(evidence_path, evidence)

    async def run() -> None:
        guard = OneAttemptPerOperation()
        results: list[dict[str, object]] = []
        actual_cost_micros = 0
        exposure_micros = 0
        async with httpx.AsyncClient(
            trust_env=False,
            event_hooks={"request": [guard.on_request]},
        ) as client:
            runtime = ProviderRuntime(client)
            for profile in PROFILES:
                target = profile.target

                def record_exposure(plan) -> None:
                    nonlocal exposure_micros
                    exposure_micros += plan.accounting.maximum_cost_estimate_usd_micros

                try:
                    result = await certify_chat(
                        runtime,
                        guard,
                        target,
                        REASONING[target.provider],
                        os.environ[KEY_ENV[target.provider]],
                        max_output_tokens=MAX_OUTPUT[target.provider],
                        on_plan=record_exposure,
                    )
                    actual_cost_micros += result.estimated_cost_usd_micros
                    results.append(
                        {
                            "target": result.target,
                            "operation": "generate",
                            "status": result.status,
                            "attempts": result.attempts,
                            "usage": result.usage,
                            "estimated_cost_usd_micros": result.estimated_cost_usd_micros,
                        }
                    )
                finally:
                    _write_progress(
                        evidence_path, evidence, guard, results, actual_cost_micros, exposure_micros
                    )

            embedding = embedding_call()
            embedding_id = f"embed:openai/{embedding.model}"
            exposure_micros = int(COST_LIMIT_USD * 1_000_000)
            try:
                with guard.operation(embedding_id):
                    embedded = await runtime.embed(
                        embedding,
                        credential=ProviderCredential(
                            provider="openai", key=os.environ["OPENAI_API_KEY"]
                        ),
                    )
                assert guard.attempts[embedding_id] == 1
                assert len(embedded.embeddings) == 1 and embedded.embeddings[0]
                embedding_usage = usage_counts(embedded.usage)
                embedding_contract = CATALOG.embeddings[0]
                embedding_cost = non_generation_cost_usd_micros(
                    *embedding_usage,
                    embedding_contract.input_rate,
                    0,
                )
                actual_cost_micros += embedding_cost
                results.append(
                    {
                        "target": f"openai/{embedding.model}",
                        "operation": "embed",
                        "status": "succeeded",
                        "attempts": 1,
                        "usage": {
                            "input_tokens": embedding_usage[0],
                            "output_tokens": embedding_usage[1],
                        },
                        "estimated_cost_usd_micros": embedding_cost,
                    }
                )
            finally:
                _write_progress(
                    evidence_path,
                    evidence,
                    guard,
                    results,
                    actual_cost_micros,
                    exposure_micros,
                )

            transcription = transcription_call()
            transcription_id = f"transcribe:openai/{transcription.model}"
            try:
                with guard.operation(transcription_id):
                    transcribed = await runtime.transcribe(
                        transcription,
                        credential=ProviderCredential(
                            provider="openai", key=os.environ["OPENAI_API_KEY"]
                        ),
                    )
                assert guard.attempts[transcription_id] == 1
                assert isinstance(transcribed.text, str)
                assert isinstance(transcribed.usage, Present)
                transcription_usage = usage_counts(transcribed.usage)
                transcription_contract = CATALOG.transcriptions[0]
                transcription_cost = non_generation_cost_usd_micros(
                    *transcription_usage,
                    transcription_contract.input_rate,
                    transcription_contract.output_rate,
                )
                actual_cost_micros += transcription_cost
                results.append(
                    {
                        "target": f"openai/{transcription.model}",
                        "operation": "transcribe",
                        "status": "succeeded",
                        "attempts": 1,
                        "usage": {
                            "input_tokens": transcription_usage[0],
                            "output_tokens": transcription_usage[1],
                        },
                        "estimated_cost_usd_micros": transcription_cost,
                    }
                )
            finally:
                _write_progress(
                    evidence_path,
                    evidence,
                    guard,
                    results,
                    actual_cost_micros,
                    exposure_micros,
                )

        assert sum(guard.attempts.values()) == CALL_LIMIT
        assert actual_cost_micros <= int(COST_LIMIT_USD * 1_000_000)

    asyncio.run(run())


def _write_progress(
    path: Path,
    evidence: dict[str, object],
    guard: OneAttemptPerOperation,
    results: list[dict[str, object]],
    actual_cost_micros: int,
    exposure_micros: int,
) -> None:
    evidence["provider_calls"] = sum(guard.attempts.values())
    evidence["estimated_cost_usd"] = actual_cost_micros / 1_000_000
    evidence["conservative_exposure_usd"] = exposure_micros / 1_000_000
    evidence["results"] = results
    atomic_evidence(path, evidence)

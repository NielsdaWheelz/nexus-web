import asyncio
import os
from datetime import datetime
from pathlib import Path

import httpx
from provider_runtime import CATALOG, Present, ProviderCredential, ProviderRuntime

from nexus.services.llm_profiles import PROFILES
from nexus_test_control.provider_budget import PaidCallBudget
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
        budget = PaidCallBudget(
            call_limit=CALL_LIMIT,
            cost_limit_usd_micros=int(COST_LIMIT_USD * 1_000_000),
        )
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

                try:
                    result = await certify_chat(
                        runtime,
                        guard,
                        budget,
                        target,
                        REASONING[target.provider],
                        os.environ[KEY_ENV[target.provider]],
                        max_output_tokens=MAX_OUTPUT[target.provider],
                    )
                    actual_cost_micros += result.estimated_cost_usd_micros
                    exposure_micros = budget.reserved_cost_usd_micros
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
            embedding_contract = CATALOG.embeddings[0]
            embedding_exposure = non_generation_cost_usd_micros(
                sum(len(value.encode("utf-8")) for value in embedding.inputs),
                0,
                embedding_contract.input_rate,
                0,
            )
            budget.reserve(embedding_id, embedding_exposure)
            exposure_micros = budget.reserved_cost_usd_micros
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
                embedding_cost = non_generation_cost_usd_micros(
                    *embedding_usage,
                    embedding_contract.input_rate,
                    0,
                )
                budget.settle(embedding_id, embedding_cost)
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
            transcription_contract = CATALOG.transcriptions[0]
            transcription_token_ceiling = len(transcription.content)
            transcription_exposure = non_generation_cost_usd_micros(
                transcription_token_ceiling,
                transcription_token_ceiling,
                transcription_contract.input_rate,
                transcription_contract.output_rate,
            )
            budget.reserve(transcription_id, transcription_exposure)
            exposure_micros = budget.reserved_cost_usd_micros
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
                transcription_cost = non_generation_cost_usd_micros(
                    *transcription_usage,
                    transcription_contract.input_rate,
                    transcription_contract.output_rate,
                )
                budget.settle(transcription_id, transcription_cost)
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
        assert budget.admitted_calls == CALL_LIMIT
        assert budget.reserved_cost_usd_micros <= int(COST_LIMIT_USD * 1_000_000)
        assert actual_cost_micros == budget.actual_cost_usd_micros

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

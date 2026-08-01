import asyncio
import os
from pathlib import Path

import httpx
from provider_runtime import ProviderRuntime, ProviderTarget

from nexus_test_control.provider_budget import PaidCallBudget
from tests.hosted._provider_live import (
    OneAttemptPerOperation,
    atomic_evidence,
    base_evidence,
    certify_chat,
)


def test_pinned_openai_canary_stays_inside_the_declared_cost_ceiling() -> None:
    assert os.environ["NEXUS_HOSTED_CANARY"] == "1"
    evidence_path = Path(os.environ["NEXUS_HOSTED_EVIDENCE_PATH"])
    maximum_cost = float(os.environ["NEXUS_HOSTED_MAX_COST_USD"])
    expected_model = os.environ["NEXUS_HOSTED_MODEL"]
    evidence = base_evidence(call_limit=1, cost_limit_usd=maximum_cost)
    atomic_evidence(evidence_path, evidence)

    async def run() -> None:
        guard = OneAttemptPerOperation()
        budget = PaidCallBudget(
            call_limit=1,
            cost_limit_usd_micros=int(maximum_cost * 1_000_000),
        )
        async with httpx.AsyncClient(
            trust_env=False,
            event_hooks={"request": [guard.on_request]},
        ) as client:
            result = await certify_chat(
                ProviderRuntime(client),
                guard,
                budget,
                ProviderTarget(provider="openai", model=expected_model.removeprefix("openai/")),
                "none",
                os.environ["OPENAI_API_KEY"],
                max_output_tokens=8,
            )
        evidence["provider_calls"] = 1
        evidence["estimated_cost_usd"] = result.estimated_cost_usd_micros / 1_000_000
        evidence["conservative_exposure_usd"] = budget.reserved_cost_usd_micros / 1_000_000
        evidence["results"] = [
            {
                "target": result.target,
                "operation": "generate",
                "status": result.status,
                "attempts": result.attempts,
                "usage": result.usage,
                "estimated_cost_usd_micros": result.estimated_cost_usd_micros,
            }
        ]
        atomic_evidence(evidence_path, evidence)

    asyncio.run(run())
    assert evidence["provider_calls"] == 1
    estimated_cost = evidence["estimated_cost_usd"]
    assert isinstance(estimated_cost, int | float)
    assert 0 <= float(estimated_cost) <= maximum_cost

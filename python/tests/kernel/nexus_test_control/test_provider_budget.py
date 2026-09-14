import pytest

from nexus_test_control.provider_budget import PaidCallBudget, ProviderBudgetError


def test_paid_call_budget_refuses_calls_and_cost_before_dispatch() -> None:
    budget = PaidCallBudget(call_limit=2, cost_limit_usd_micros=10)
    budget.reserve("first", 6)

    with pytest.raises(ProviderBudgetError, match="cost ceiling"):
        budget.reserve("too-expensive", 5)

    budget.reserve("second", 4)
    with pytest.raises(ProviderBudgetError, match="call ceiling"):
        budget.reserve("third", 0)

    assert budget.admitted_calls == 2
    assert budget.reserved_cost_usd_micros == 10


def test_paid_call_budget_requires_unique_reservation_and_bounded_settlement() -> None:
    budget = PaidCallBudget(call_limit=1, cost_limit_usd_micros=10)
    budget.reserve("one", 8)

    with pytest.raises(ProviderBudgetError, match="unique reservation"):
        budget.reserve("one", 8)
    with pytest.raises(ProviderBudgetError, match="exceeded"):
        budget.settle("one", 9)

    budget.settle("one", 7)
    assert budget.actual_cost_usd_micros == 7
    with pytest.raises(ProviderBudgetError, match="unsettled"):
        budget.settle("one", 7)

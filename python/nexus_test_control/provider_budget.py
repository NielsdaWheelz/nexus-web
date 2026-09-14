from __future__ import annotations


class ProviderBudgetError(RuntimeError):
    pass


class PaidCallBudget:
    """Admit each paid operation before dispatch against fixed call and exposure caps."""

    def __init__(self, *, call_limit: int, cost_limit_usd_micros: int) -> None:
        if call_limit <= 0 or cost_limit_usd_micros <= 0:
            raise ValueError("paid-call limits must be positive")
        self.call_limit = call_limit
        self.cost_limit_usd_micros = cost_limit_usd_micros
        self._reservations: dict[str, int] = {}
        self._settled: dict[str, int] = {}

    def reserve(self, operation_id: str, maximum_cost_usd_micros: int) -> None:
        if not operation_id or operation_id in self._reservations:
            raise ProviderBudgetError("provider operation must have one unique reservation")
        if maximum_cost_usd_micros < 0:
            raise ProviderBudgetError("provider exposure cannot be negative")
        if len(self._reservations) >= self.call_limit:
            raise ProviderBudgetError("provider call ceiling reached before dispatch")
        if self.reserved_cost_usd_micros + maximum_cost_usd_micros > self.cost_limit_usd_micros:
            raise ProviderBudgetError("provider cost ceiling reached before dispatch")
        self._reservations[operation_id] = maximum_cost_usd_micros

    def settle(self, operation_id: str, actual_cost_usd_micros: int) -> None:
        reserved = self._reservations.get(operation_id)
        if reserved is None or operation_id in self._settled:
            raise ProviderBudgetError("provider operation has no unsettled reservation")
        if actual_cost_usd_micros < 0 or actual_cost_usd_micros > reserved:
            raise ProviderBudgetError("provider accounting exceeded its pre-dispatch reservation")
        self._settled[operation_id] = actual_cost_usd_micros

    @property
    def admitted_calls(self) -> int:
        return len(self._reservations)

    @property
    def reserved_cost_usd_micros(self) -> int:
        return sum(self._reservations.values())

    @property
    def actual_cost_usd_micros(self) -> int:
        return sum(self._settled.values())

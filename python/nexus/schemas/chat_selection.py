"""Account-wide last accepted chat generation identity."""

from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.llm import CodexPersonalRoute, GenerationSelection, ProviderApiRoute


class ChatSelectionChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    route: Annotated[CodexPersonalRoute | ProviderApiRoute, Field(discriminator="kind")]
    selection: GenerationSelection

    @model_validator(mode="after")
    def _matching_route(self) -> Self:
        if self.route.kind != self.selection.route:
            raise ValueError("chat selection route must match its selection")
        return self


class RememberedChatSelection(ChatSelectionChoice):
    revision: OrderRevision


class ChatSelectionOut(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    last_used: RememberedChatSelection | None

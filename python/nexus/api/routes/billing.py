"""Billing routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.billing import BillingCheckoutRequest, BillingSessionOut
from nexus.services import billing as billing_service

router = APIRouter(tags=["billing"])


@router.get("/billing/account")
def get_billing_account(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    out = billing_service.get_billing_account(db, viewer.user_id)
    return success_response(out.model_dump(mode="json"))


@router.post("/billing/checkout")
def create_checkout_session(
    body: BillingCheckoutRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    url = billing_service.create_checkout_session(
        db,
        viewer.user_id,
        viewer.email,
        body.plan_tier,
    )
    return success_response(BillingSessionOut(url=url).model_dump(mode="json"))


@router.post("/billing/portal")
def create_customer_portal_session(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    url = billing_service.create_customer_portal_session(db, viewer.user_id)
    return success_response(BillingSessionOut(url=url).model_dump(mode="json"))


@router.post("/billing/stripe/webhook")
async def process_stripe_webhook(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    stripe_signature: Annotated[str | None, Header(alias="stripe-signature")] = None,
) -> dict:
    out = billing_service.process_stripe_webhook(db, await request.body(), stripe_signature)
    return success_response(out)

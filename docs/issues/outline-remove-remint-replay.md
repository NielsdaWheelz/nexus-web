# removing and reminting a link can fail exact replay

problem: an outline batch can remove an existing link, then insert the same id
with a concrete versioned position. the first request can commit; exact replay
then fails the position check after removing the link again in its transaction.

source evidence: recorded `origin/main` `f658f25481ba`,
`python/nexus/services/outline.py:243-246,255-263,307-324,395-415,526-540`; since the
notes re-slice `apply_in_current_transaction` (`:184`) checks positions against the
lane's version before the batch's first bump of it (`:227-231`), with the same
result. insertion checks the transaction-start links version after the prior
removal; the minted-id safeguard handles removal after insertion, not this order.
reproduced live: notes harness `api/A15` (replay 409 "Outline version changed").

candidate reproduction (NOT_RUN): create an owned page and readable media with
one unannotated user link `e`; read the page links version `v`. submit
`remove(endpoint=page, link_id=e, expected_body_version=null)` followed by
`insert_link(link_id=e, source=page, target=media, position={after:null,
expected_links_version:v}, require_created=false)`. replay the identical batch.
source predicts initial success followed by `409 E_RESOURCE_CONFLICT`,
`Outline version changed`; qualify this through a real isolated api/database.

impact: a lost response can turn an accepted structural change into an apparent
refusal. separate from a batch deleting its own `set_body` target.

resolved when the shape is rejected atomically before admission, or its exact
replay converges without changing the accepted effect. no replay ledger.

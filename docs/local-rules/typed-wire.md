# typed wire

owner decision 2026-09-28. the web does not hand-validate its own FastAPI JSON:
its wire types are generated from FastAPI's OpenAPI schema, so tsc catches drift.

## python

- a JSON route declares its response through its return annotation, which
  FastAPI uses as the response model, and returns that model. `Data[XOut]`
  (`nexus/responses.py`) is `{"data": X}`; `DataPage[XOut, PageOut]` is
  `{"data": [X], "page": P}`; any other shape is its own model. `ok()`,
  `ok_page()` and `success_response()` go route by route as routes are typed.
- typing a route keeps its JSON byte for byte. check it against the old route
  before merging.
- FastAPI writes the schema by alias and serializes response models by alias.
  never set `response_model_by_alias=False`: the bytes would then disagree with
  the schema. a route that dumped by field name (`ok()`'s default) keeps its
  bytes only if its models (nested ones included) have no aliases on output;
  make an input-only alias a `validation_alias`.
- always-serialized fields of an Out model must be required in its output
  schema. `json_schema_serialization_defaults_required=True` on that selected
  output model keeps useful nullable/factory constructor defaults while making
  their wire presence explicit. it does not apply to input models or global
  bases, and does not turn genuinely omitted/excluded fields into output keys.
  without that setting, an Out field has no `None` default or `default_factory`:
  either generates an optional key for a field that is always sent. plain
  non-None defaults (`= False`) generate required output fields and may stay.
- a route that returned `JSONResponse` was serialized by `json.dumps`; the
  typed route is serialized by pydantic, which renders floats in exponent form
  differently (`1e-05` becomes `0.00001`). a dynamic status or header goes on
  an injected `Response`, and the route still returns the model.
- atlas is the named conditional-json exception: `GET /atlas` explicitly declares
  `Data[AtlasOut]`, constructs that validated envelope, renders one `JSONResponse`
  and hashes its actual body before returning 200 or bodyless 304. this preserves
  the existing standard-json float bytes and makes the tag identify exactly what
  is sent. the [atlas owner](../modules/atlas.md#conditional-http-owner) specifies
  this boundary; other typed json routes return their model directly.
- 204, binary, redirect and SSE routes keep their shape.
- an SSE `data:` frame that is a model as-is is listed in `nexus/wire_schema.py`
  and generates under its own name, e.g. `Schema<"ChatRunDoneEventPayload">`.
  chat citation-index/context-ref-added and oracle passage share the canonical
  snake `ResourceActivationOut` and are registered with the other SSE payloads.

## generation

- `python -m nexus.wire_schema` prints FastAPI's OpenAPI document, built from
  the routers with every deployment toggle on, plus the SSE payload models, as
  sorted JSON. it needs no settings, database, network or secrets. two
  different schemas with one name fail it; rename one model.
- `cd apps/web && bun run gen:wire` renders it with `openapi-typescript`
  (pinned) to `apps/web/src/lib/api/wire.gen.ts`, which is committed, marked
  generated, ignored by eslint and excluded from line targets.
- `./scripts/test` regenerates it into a temp file and fails when the
  committed file differs.

## web

- `apps/web/src/lib/api/wire.ts` exports `Schema<"XOut">` (a component schema)
  and `ApiJson<"/path/{param}", "get">` (the success JSON body, envelope
  included; a method without one does not type-check). write
  `apiFetch<ApiJson<"/media/transcript/forecasts", "post">>("/api/media/transcript/forecasts", init)`
  and read typed fields. an untyped route's `ApiJson` is `{[key: string]: unknown}`
  (`unknown` for one that returns a raw `Response`): type the route first.
- no hand decoder or hand-written interface for same-deploy FastAPI JSON.
  strict runtime decoding stays only where versions drift: the android bridge,
  the browser extension, persisted browser storage (sessionStorage,
  localStorage, server-stored client blobs such as the workspace session), and
  cross-origin postMessage.

## migration

a slice that rewrites routes types all of its routes and deletes their web
decoders in the same PR. until every slice has run, typed and untyped routes
coexist; [../reauthoring.md](../reauthoring.md) counts the untyped remainder.

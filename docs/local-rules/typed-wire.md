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
- every wire key is snake_case: the python field name. no wire model sets an
  `alias`, `serialization_alias` or `alias_generator`, and no route or dump
  passes `by_alias` (owner decision 2026-10-13). an alias survives only where
  the name is not ours: a header, a python keyword (`from`), a provider's
  schema field, an opaque sealed payload.
- users, library invitations and resource grants are addressed by plain uuids
  (owner decision 2026-10-10); this overrides the sealed-handle default of
  [../rules/keys-and-identities.md](../rules/keys-and-identities.md) for them.
  share tokens, upload sessions and discovery targets stay sealed.
- absence is `null`: an optional value is `T | None` in python and `T | null`
  on the web, its key always present on output. this overrides the
  `Presence<T>` rule of [../rules/boundaries.md](../rules/boundaries.md),
  [../rules/json-values.md](../rules/json-values.md) and
  [../rules/frontend.md](../rules/frontend.md) (owner decision 2026-10-13). a
  request PATCH that tells an omitted key from `null` reads `model_fields_set`.
- a `strict=True` model with a uuid, datetime, date, decimal, enum or tuple
  field reads JSON only in JSON mode (`model_validate_json`,
  `validate_json(json.dumps(value))`): there strict takes those as JSON
  strings and arrays, while python-mode strict refuses them in a decoded
  dict. FastAPI is the one exception: it validates a decoded request body in
  python mode, so a strict request model marks each such field
  `Field(strict=False)` (for a uuid this accepts exactly what JSON-mode
  strict accepts) and has no tuple field.
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
- 204, binary, redirect and SSE routes keep their shape.
- an SSE `data:` frame that is a model as-is is listed in `nexus/wire_schema.py`
  and generates under its own name, e.g. `Schema<"ChatRunDoneEventPayload">`.
  chat citation-index/context-ref-added share the canonical snake
  `ResourceActivationOut` and are registered with the other SSE payloads.

## generation

- `python -m nexus.wire_schema` prints FastAPI's OpenAPI document, built from
  the routers with every deployment toggle on, plus the SSE payload models and
  the explicit native payload `PlayerDescriptor`, as
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
  localStorage), and cross-origin postMessage.
- a server-stored client blob is validated by the api, not by a web decoder:
  the workspace session is a pydantic model on its GET/PUT. only a missing row
  is null; a present invalid row raises `E_INTERNAL` without being modified. the
  web's state type is the generated schema.

## migration

a slice that rewrites routes types all of its routes and deletes their web
decoders in the same PR. until every slice has run, typed and untyped routes
coexist; [../reauthoring.md](../reauthoring.md) counts the untyped remainder.

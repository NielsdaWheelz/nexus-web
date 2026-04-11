# Keys And Identities

## Scope

This document covers identity and authority naming and sealing rules.

## Id

- Meaningless private identity should use UUID-backed `*Id` values.
- `*Id` means private meaningless identity.
- Do not expose `*Id` directly at end-user boundaries.

## Key

- Meaningful identity should use `*Key` values.
- Do not replace meaningful identity with meaningless UUIDs just because it identifies something.

## Handle

- `*Handle` means outward opaque identity.
- Handles are sealed outward forms of internal identity.
- End-user boundaries prefer handles for outward opaque identity.
- Do not call an outward handle `id`.

## Token And ApiKey

- `*Token` and `*ApiKey` mean outward bearer or capability strings.
- Tokens and API keys are authority, not identity pointers.

## Ref

- `*Ref` is only for lower-layer references such as provider-owned or infrastructure-owned pointers.
- Do not use `*Ref` for outward opaque values or DTO wrappers.

## Specific Names

- Prefer the most specific honest domain name.
- `Id`, `Key`, `Handle`, `Token`, `ApiKey`, and `Ref` are fallback categories, not the only allowed names.
- Use the same specific name across boundaries when the concept itself is the same.

## Sealing

- Use sealing only at end-user boundaries to hide private IDs and similar internal references.
- Internally, always use private IDs and internal references.
- Handler and service code owns unseal, classification, and conversion from malformed outward values into domain errors.

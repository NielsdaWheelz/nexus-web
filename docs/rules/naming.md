# Naming

## Scope

This document covers global naming grammar for identifiers and observability labels.

## Enums

- Enums are `PascalCase` strings.

## Identifiers

- String-valued identifiers in a global namespace should use dot-delimited PascalCase.
- Service tags, error tags, and local union discriminators should use flat PascalCase with no dot.

## Observability

- Observability names use a different grammar to align with OpenTelemetry conventions.
- Span names and similar nominal observability labels should use dot-delimited PascalCase.
- Span and log attribute keys are field paths, not nominal labels.
- Span and log attribute keys should use lowercase dotted field paths.
- Do not use camelCase attribute keys.
- Do not reuse nominal-identifier PascalCase grammar for observability attribute keys.

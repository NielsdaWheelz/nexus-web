# Conventions

## Scope

This document covers small implementation conventions that do not belong to a larger topic.

## Named Constants

- Extract a value into a named constant when the name conveys information beyond what the usage site already says.
- Keep a value inline when it is inherently part of the expression.

## Lossy Conversions

- When converting from a rich type to a lossy or primitive representation, perform the conversion as late as possible — inline at the consumption site.
- Do not pre-compute lossy forms into variables.

## Base64

- Default to base64url encoding.
- Use base64 only with `justify-base64-over-base64url`.

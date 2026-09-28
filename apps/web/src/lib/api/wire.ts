// Names for FastAPI's wire types (docs/local-rules/typed-wire.md).
import type { components, paths } from "./wire.gen";

/** A component schema of the API, e.g. `Schema<"BillingAccountOut">`. */
export type Schema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

type SuccessJson<Operation> = Operation extends { responses: infer Responses }
  ? {
      [Status in keyof Responses & (200 | 201 | 202)]: Responses[Status] extends {
        content: { "application/json": infer Body };
      }
        ? Body
        : never;
    }[keyof Responses & (200 | 201 | 202)]
  : never;

type JsonMethod<Path extends keyof paths> = {
  [Method in keyof paths[Path]]-?: [SuccessJson<paths[Path][Method]>] extends [never]
    ? never
    : Method;
}[keyof paths[Path]];

/**
 * The JSON body, envelope included, of the operation's success response (the one
 * 200, 201 or 202 FastAPI declares), e.g. `ApiJson<"/billing/account", "get">`.
 * A method without such a body does not type-check.
 */
export type ApiJson<
  Path extends keyof paths,
  Method extends JsonMethod<Path>,
> = SuccessJson<paths[Path][Method]>;

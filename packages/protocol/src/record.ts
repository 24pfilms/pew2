/**
 * Reading untyped JSON one checked field at a time.
 *
 * Agent payloads and on-disk transcripts arrive from processes neither side
 * controls, so a field is `unknown` until something has looked at it. This is
 * the narrowing step: any non-null object (arrays included, exactly as `?.`
 * would treat them) comes back as a record of still-unknown fields; anything
 * else comes back undefined, so a chain of these reads like optional chaining
 * without ever handing out `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A field that is only kept when it is a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

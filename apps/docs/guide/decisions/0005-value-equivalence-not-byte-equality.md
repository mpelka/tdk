# 5. Value-equivalence, never byte-equality

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

Gold standards and the stability contract need a definition of what stays stable when a
template is recompiled with a newer TDK. The choice is between promising byte-identical
output and promising semantically equivalent output.

## Decision

Promise that recompiled output stays semantically equivalent, not byte-identical. Gold
standards assert on value, never on bytes.

## Alternatives considered

- Byte-equality — rejected. It would freeze every improvement to how TDK emits YAML,
  because any change to formatting or expression emission moves bytes even when the
  behaviour is identical.

## Consequences

- TDK can improve its emission over time without breaking the contract.
- The full reasoning, including why byte-identity would freeze every improvement, is in
  the [stability contract](/guide/stability).

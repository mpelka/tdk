# 17. Never guess a provenance value

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A dry-run's resolved values are recovered from the scaffolder log best-effort. Sometimes
a value cannot be recovered. The row has to show something.

## Decision

When a value cannot be recovered, render the row with the expression alone.

## Alternatives considered

- Showing `undefined`, or a plausible-looking value — rejected. That would be a
  fabricated value the trace cannot stand behind.

## Consequences

- A row that shows only the expression is honest about what is known: the source, not the
  result.
- See [provenance rows](/guide/vscode#provenance-rows).

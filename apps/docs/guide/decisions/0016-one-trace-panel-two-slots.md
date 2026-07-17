# 16. One trace panel with two slots, not two panels

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The extension shows two traces of the same form values: a local simulate and a Backstage
dry-run. Comparing them is the whole point. The two could live in one panel or in two.

## Decision

Keep two retained slots in one trace panel: Local simulate and Backstage dry-run.
Normalize Backstage's dry-run responses into the local trace's schema through per-source
adapters, because the local format is the richer one.

## Alternatives considered

- Two separate panels — rejected. They would split the comparison across two places, when
  comparing the two traces is the reason they exist.

## Consequences

- One detail component renders both, so the two traces read identically and any difference
  is a real difference, not a presentation artefact.
- See [the TDK Trace panel](/guide/vscode#the-tdk-trace-panel).

# 18. Live simulate is gated, dry-run is a click

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The extension runs two kinds of trace. A local simulate is free; a network call to
Backstage costs something. And an invalid form produces a garbage trace.

## Decision

Run the local simulate live as the form changes, but only while the form is valid. Make
the dry-run an explicit button.

## Alternatives considered

- Running the live simulate against a half-filled, invalid form — rejected. Its trace is
  garbage — an error trace and downstream noise — that teaches wrong lessons.
- Making the dry-run live too — rejected. A network call to Backstage should be
  deliberate, not fired on every keystroke.

## Consequences

- Simulation is free, so it is live; a Backstage call costs something, so it is
  deliberate.
- The live simulate is gated on validity rather than run against a half-filled form.
- See [gating](/guide/vscode#gating).

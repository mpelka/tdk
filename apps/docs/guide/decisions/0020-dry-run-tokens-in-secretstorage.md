# 20. Dry-run tokens live in SecretStorage

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The dry-run needs a Backstage bearer token. A token in `settings.json` would be committed
or synced by accident.

## Decision

Store the Backstage bearer token in VS Code SecretStorage, never in a settings file, and
keep it out of logs.

## Alternatives considered

- Storing the token in `settings.json` — rejected. It would be committed or synced by
  accident.

## Consequences

- SecretStorage is the store built for exactly this.
- See [set-up commands](/guide/vscode#set-up-commands).

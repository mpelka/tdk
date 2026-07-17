# 14. The extension shells out to the workspace CLI

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The VS Code extension compiles a preview. It could run the workspace's own `tdk` CLI, or
it could bundle a compiler of its own. The preview has to compile with the exact `tdk`
version the project builds with.

## Decision

Run the workspace's own `tdk` CLI, resolved through the chain setting to workspace binary
to `PATH` to `~/.bun/bin`, with no `npx` or `bunx` fallback.

## Alternatives considered

- Bundling a compiler into the extension — rejected. It would drift from the project's
  version and show a preview that does not match the build.
- An `npx` or `bunx` fallback — rejected. The `tdk` package on the npm registry is an
  unrelated third party's, and piping template source to it would be a security hazard.

## Consequences

- The preview always matches the version the project builds with.
- See
  [the extension finds your workspace CLI](/guide/vscode#the-extension-finds-your-workspace-cli).

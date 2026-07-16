---
"tdk-vscode": patch
---

Consume core's Backstage client and `fromYaml` instead of the extension's own copies. The dry-run client (`lib/dryRunClient.ts`) and the plain-YAML detector (`lib/yamlTemplate.ts`) moved into `@tdk/core` — the client behind the `@tdk/core/backstage` subpath, `fromYaml` as a main export — so the extension now imports them from there and its duplicated modules are deleted. Their unit tests moved to core alongside them.

This is an internal refactor with no user-visible change: the dry-run submit flow, the plain-YAML form preview, the trace panel, and every message shape behave exactly as before. The existing React Testing Library, live-Backstage, and built-bundle smoke tests stay green unchanged, and a new bundle smoke test exercises the `@tdk/core` / `@tdk/core/backstage` import seam through the production extension-host bundler. The presentation-layer code (dry-run presentation, trace normalization, log grouping) stays in the extension.

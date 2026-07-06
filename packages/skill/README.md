# @tdk/skill

This package holds `SKILL.md` — an agent skill that teaches a coding agent to author and
test TDK templates. It covers the mental model, the `defineTemplate` authoring surface,
env-aware values, compile-time data, and scenario tests, all in the bakery theme.

A coding agent loads it as a skill so it can write schema-valid template YAML without
hand-writing JSON Schema, JSONata, Nunjucks, or YAML. Humans should read the
[documentation site](../../apps/docs) instead — run it locally with
`bun run --cwd apps/docs docs:dev`.

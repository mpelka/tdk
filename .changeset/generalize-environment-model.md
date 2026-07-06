---
"@tdk/core": major
"@tdk/cli": major
---

The environment model is generalized beyond the built-in `test`/`prod` pair. `env` is now an open `string` everywhere (`Target.env`, `LoadContext.env`, `ActionSimContext.env`), `Targets` is `Record<string, Target>` with arbitrary names, and `env.pick({...})` accepts arbitrary env-name keys plus an optional reserved `default` fallback (resolution order: exact env match, then `default`, then a loud throw naming the pick's known envs). The CLI's `-e/--env` flag now accepts any env name (the `test|prod` choices restriction is gone); the default stays `test`.

Env-safety checking is also strengthened: an artifact for env `E` must not contain any pick value exclusive to another env, and this is now checked for **every** env (previously only `test` artifacts were scanned). Renamed: `prodOnlyValues` → `exclusiveValuesByEnv`, `assertNoProdLeaks` → `assertNoCrossEnvLeaks`.

**Breaking for one narrow case.** Existing two-env (`test`/`prod`) configs compile unchanged — this was verified empirically (gold/snapshot output is byte-identical). The one real migration: code that indexes a narrow `Record<"test" | "prod", …>` type from `ctx.env` inside a `load()` or a custom action simulator must widen that type to `Record<string, …>` (or an equivalent open-string-keyed shape), since `ctx.env` is no longer narrowed to the two literal envs.

Bump level: pre-1.0 convention would allow a minor for this; `major` is used to make the rename and the widened-checking behavior visible in the changelog.

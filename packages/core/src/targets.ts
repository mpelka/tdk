// Compile targets + config.
//
// A single template definition fans out to one artifact per target. Each target
// names the Backstage env its `env.pick`s resolve against and an output dir.

import type { Template } from "./template.ts";

/** The template fields exposed to a target's `out(...)` path function. */
export interface TemplateMeta {
  /** Template id — becomes `metadata.name`. */
  id: string;
  title: string;
  type: string;
}

/**
 * A deploy target: which env to resolve for, and where to write the YAML.
 * Give it EITHER `outDir` (sugar for the nested default) OR `out` (any layout).
 */
export interface Target {
  /**
   * Backstage env — drives `env.pick` resolution. Any string: `"test"` /
   * `"prod"`, or `"dev"` / `"staging"` / whatever your org runs. A pick with no
   * value for this env (and no `default`) throws at compile, naming the miss.
   */
  env: string;
  /**
   * Sugar: write each template to `<outDir>/<id>/template.yaml` (nested — the
   * Backstage catalog-discovery convention). For any other layout, use `out`.
   */
  outDir?: string;
  /**
   * Full output path per template, relative to the config file — overrides
   * `outDir` and expresses any layout:
   * ```ts
   * out: (t) => `../foo-nonprod/templates/${t.id}.yaml`  // flat bucket
   * out: (t) => `../foo-nonprod/${t.id}/template.yaml`    // nested (same as outDir)
   * ```
   */
  out?: (tpl: TemplateMeta) => string;
}

/**
 * The named deploy targets a config fans out to. Arbitrary target names, each an
 * env + output layout — the names are just names (no key has special meaning;
 * `nonprod`/`prod` are a convention, not a requirement). At least one entry is
 * required — enforced at runtime in `defineConfig` / `compileAll`.
 */
export type Targets = Record<string, Target>;

/**
 * A template entry in a config / what `compile`/`execute` accept. Every template
 * is now a `defineTemplate(...)` value (a `Template` instance); this alias names
 * that "template-shaped input" at the public API boundary.
 */
export type TemplateInput = Template;

export interface TdkConfig {
  templates: TemplateInput[];
  targets: Targets;
}

/**
 * Define a TDK project config. Mostly an identity helper that gives editors the
 * right types and a single object for the compile CLI/runner to consume.
 *
 * ```ts
 * export default defineConfig({
 *   templates: [OrderCake],
 *   targets: {
 *     nonprod: { env: "test", outDir: "dist/nonprod" },                         // nested
 *     prod:    { env: "prod", out: (t) => `dist/prod/templates/${t.id}.yaml` },  // flat bucket
 *   },
 * });
 * ```
 */
export function defineConfig(config: TdkConfig): TdkConfig {
  if (Object.keys(config.targets).length === 0) {
    throw new Error(`defineConfig: "targets" needs at least one entry (a named { env, outDir | out } target).`);
  }
  return config;
}

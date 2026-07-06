// End-to-end coverage for the generalized `-e/--env` flag: it now accepts ANY
// env name (the Commander `.choices(["test","prod"])` gate is gone), so `-e
// staging` compiles a template's env.pick against its "staging" slot. Spawns the
// real `src/cli.ts` bin so the whole Commander → lib → core path is exercised.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "cli.ts");

/** A scratch template with a three-env pick (dev / staging / prod) + a default. */
const THREE_ENV_TEMPLATE = `import { defineTemplate, env, p, step } from "@tdk/core";
export default defineTemplate({
  id: "three-env-fixture",
  title: "Three Env",
  description: "d",
  type: "service",
  parameters: { who: p.string({ title: "Who" }) },
  steps: () => [
    step("provision", "debug:log", {
      name: "Provision",
      input: {
        cluster: env.pick({ dev: "dev-cluster", staging: "stg-cluster", prod: "prod-cluster" }),
        region: env.pick({ prod: "eu-west", default: "eu-central" }),
      },
    }),
  ],
});
`;

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

let pkgTmp: string;
let template: string;
beforeAll(async () => {
  // Scratch INSIDE the package so the scaffolded template resolves @tdk/core.
  pkgTmp = await mkdtemp(join(here, "..", "..", ".tmp-env-cli-"));
  template = join(pkgTmp, "template.ts");
  await mkdir(pkgTmp, { recursive: true });
  await writeFile(template, THREE_ENV_TEMPLATE, "utf8");
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

describe("tdk compile -e <arbitrary env>", () => {
  test("-e staging resolves the staging slot + the default fallback, exit 0", async () => {
    const { stdout, code } = await runCli(["compile", template, "-e", "staging"]);
    expect(code).toBe(0);
    expect(stdout).toContain("cluster: stg-cluster");
    // `region` has no staging entry -> the default fallback.
    expect(stdout).toContain("region: eu-central");
    expect(stdout).not.toContain("dev-cluster");
    expect(stdout).not.toContain("prod-cluster");
  });

  test("-e dev resolves the dev slot", async () => {
    const { stdout, code } = await runCli(["compile", template, "-e", "dev"]);
    expect(code).toBe(0);
    expect(stdout).toContain("cluster: dev-cluster");
    expect(stdout).toContain("region: eu-central");
  });

  test("-e prod resolves the prod slot + its explicit region", async () => {
    const { stdout, code } = await runCli(["compile", template, "-e", "prod"]);
    expect(code).toBe(0);
    expect(stdout).toContain("cluster: prod-cluster");
    expect(stdout).toContain("region: eu-west");
  });

  test("the default -e is still test — an env the pick doesn't know fails loudly", async () => {
    // No "test" slot on `cluster` and no default there -> the pointed pick error.
    const { stderr, code } = await runCli(["compile", template]);
    expect(code).toBe(1);
    expect(stderr).toContain('env.pick has no value for env "test"');
    expect(stderr).toContain("knows: dev, staging, prod");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileResolved } from "../index.ts";
import type { MigrationModel } from "./model.ts";
import { printTemplate } from "./print.ts";
import { formatModelErrors, validateModel } from "./validate.ts";

const here = dirname(fileURLToPath(import.meta.url));

// The emitted-code injection guard (ADR-0026 / the adversarial review of PR #35).
//
// Model string fields flow into the printer's OUTPUT — names become identifiers and
// step ids; kind/source/actionRef are interpolated into `//` comments and `raw`
// placeholders. A control char, a JS line terminator (\n \r U+2028 U+2029), or a
// backtick could break out and inject code that still PARSES. Defense in depth:
//   (1) VALIDATION rejects them with a path-quality message (this suite's probes).
//   (2) EMISSION sanitizes every interpolation (this suite's sanitized-emission test).

// Control chars via fromCharCode so the test SOURCE stays pure ASCII.
const NL = "\n";
const CR = "\r";
const LS = String.fromCharCode(0x2028); // JS line separator — terminates a // comment too
const BEL = String.fromCharCode(0x07); // a C0 control character
const BT = "`"; // backtick

function base(): MigrationModel {
  return {
    modelVersion: "1",
    template: { id: "t", title: "T" },
    questions: [{ name: "x", type: "string", page: "P" }],
  };
}

describe("validation rejects injection vectors (the probe matrix)", () => {
  // P1 — lookup.source carrying a newline (comment breakout).
  test("P1: lookup.source with a newline is rejected", () => {
    const m = base();
    m.lookups = [{ name: "lk", kind: "roster", source: `roster://x${NL}const injected = 1;` }];
    const r = validateModel(m);
    expect(r.valid).toBe(false);
    expect(formatModelErrors(r.errors)).toContain("lookups[0].source: contains a control character or line break");
  });

  // P2 — lookup.kind carrying a newline (comment breakout via the kind line).
  test("P2: lookup.kind with a newline is rejected", () => {
    const m = base();
    m.lookups = [{ name: "lk", kind: `roster${NL}evil`, source: "roster://x" }];
    expect(validateModel(m).valid).toBe(false);
    expect(formatModelErrors(validateModel(m).errors)).toContain("lookups[0].kind: contains a control character");
  });

  // P4 — escape-hatch NAME carrying a backtick (raw`` breakout).
  test("P4: escape-hatch name with a backtick is rejected", () => {
    const m = base();
    m.logic = [{ name: `esc${BT});evil((`, kind: "expression", language: "jsonata", source: "1" }];
    expect(validateModel(m).valid).toBe(false);
    expect(formatModelErrors(validateModel(m).errors)).toContain("backtick");
  });

  // P5 — lookup.name carrying a backtick (raw`` placeholder breakout).
  test("P5: lookup.name with a backtick is rejected", () => {
    const m = base();
    m.lookups = [{ name: `lk${BT}evil`, kind: "roster", source: "roster://x" }];
    expect(validateModel(m).valid).toBe(false);
    expect(formatModelErrors(validateModel(m).errors)).toContain("lookups[0].name");
  });

  // P6 — effect.actionRef carrying a newline (comment + parse breakout).
  test("P6: effect.actionRef with a newline is rejected", () => {
    const m = base();
    m.effects = [{ name: "e", kind: "k", actionRef: `legacy:x${NL}evil` }];
    expect(validateModel(m).valid).toBe(false);
    expect(formatModelErrors(validateModel(m).errors)).toContain("effects[0].actionRef");
  });

  test("a question name with a newline (banner breakout) is rejected", () => {
    const m = base();
    m.questions.push({ name: `y${NL}evil`, type: "string", page: "P" });
    expect(validateModel(m).valid).toBe(false);
    expect(formatModelErrors(validateModel(m).errors)).toContain("questions[1].name");
  });

  test("a logic name with a newline is rejected", () => {
    const m = base();
    m.logic = [{ name: `d${NL}evil`, op: "literal", value: 1 }];
    expect(validateModel(m).valid).toBe(false);
  });

  test("a U+2028 line separator in a name is rejected", () => {
    const m = base();
    m.lookups = [{ name: `lk${LS}evil`, kind: "roster", source: "roster://x" }];
    expect(validateModel(m).valid).toBe(false);
  });

  test("a carriage return in lookup.source is rejected", () => {
    const m = base();
    m.lookups = [{ name: "lk", kind: "roster", source: `roster://x${CR}evil` }];
    expect(validateModel(m).valid).toBe(false);
  });

  test("template.id with a path separator is rejected (directory-traversal guard)", () => {
    const m = base();
    m.template.id = "../../etc/passwd";
    const r = validateModel(m);
    expect(r.valid).toBe(false);
    expect(formatModelErrors(r.errors)).toContain(
      "template.id: contains a control character, line break, or path separator",
    );
  });

  test("template.id with a newline is rejected", () => {
    const m = base();
    m.template.id = `t${NL}evil`;
    expect(validateModel(m).valid).toBe(false);
  });
});

describe("emission sanitizes benign multi-line + defends in depth", () => {
  test("a benign MULTI-LINE escape source prints as a well-formed multi-line comment", () => {
    const m = base();
    // The escape-hatch source is the ONE field allowed to be multi-line; it is split
    // (on all JS line terminators) into sanitized comment lines.
    m.logic = [
      { name: "esc", kind: "expression", language: "jsonata", source: `good1${NL}GOOD_MARKER${CR}${NL}good3` },
    ];
    m.effects = [{ name: "e", kind: "k", actionRef: "legacy:x", inputs: { v: { logicRef: "esc" } } }];
    expect(validateModel(m).valid).toBe(true);

    const ts = printTemplate(m).files["template.ts"];
    // Every line mentioning the injected marker is INSIDE a comment — no breakout.
    for (const line of ts.split("\n")) {
      if (line.includes("GOOD_MARKER")) expect(line.trimStart().startsWith("//")).toBe(true);
    }
    expect(ts).toContain("//   source: good1");
    expect(ts).toContain("//   source: GOOD_MARKER");
    expect(ts).toContain("//   source: good3");
  });

  test("defense in depth: a raw`` placeholder escapes a backtick even if validation is bypassed", () => {
    // Call printTemplate DIRECTLY (validation would reject this) to prove the emission
    // layer itself is safe: the backtick in the name is escaped in the raw`` literal.
    const evilName = `a${BT}b`;
    const m = base();
    m.lookups = [{ name: evilName, kind: "roster", source: "roster://x" }]; // unmapped → raw placeholder
    const ts = printTemplate(m).files["template.ts"];
    // escapeTemplate turns a`b into a\`b — the backtick is backslash-escaped.
    const escaped = `a${"\\"}${BT}b`;
    expect(ts).toContain(`unresolved lookup: ${escaped}`);
    // And no bare (unescaped) backtick breakout landed at statement position.
    expect(ts).not.toContain(`lookup: a${BT}b`);
  });

  test("a control character embedded in an escape-source line is stripped from the comment", () => {
    const m = base();
    m.logic = [{ name: "esc", kind: "expression", language: "jsonata", source: `a${BEL}b` }];
    m.effects = [{ name: "e", kind: "k", actionRef: "legacy:x", inputs: { v: { logicRef: "esc" } } }];
    const ts = printTemplate(m).files["template.ts"];
    expect(ts).toContain("//   source: a b"); // the control char replaced by a space
  });
});

// The extraSpec escape hatch is the ONE model position that is free-form (not subject to
// the strict name/id char patterns) yet still emitted. Its keys and values land in a TS
// OBJECT LITERAL rendered by `lit()` — every leaf goes through JSON.stringify, which
// escapes any character inside a double-quoted string. So a backtick, `${`, a newline, or
// a quote in an extraSpec value cannot break out; it round-trips faithfully into the
// compiled spec. This suite proves both halves: validation ACCEPTS the hostile values,
// and the emitted file PARSES and carries them into `spec` byte-for-byte.
describe("extraSpec — the emission-safe escape hatch", () => {
  // A scratch dir INSIDE the package so the emitted template can resolve @tdk/core when
  // we import it back (Bun walks up to the workspace node_modules).
  let pkgTmp: string;
  beforeAll(async () => {
    pkgTmp = await mkdtemp(join(here, "..", ".tmp-extraspec-"));
  });
  afterAll(async () => {
    await rm(pkgTmp, { recursive: true, force: true });
  });

  // Every classic breakout character, all inside string VALUES (and object KEYS), nested.
  const hostileExtraSpec = {
    "catalog-metadata": {
      backtick: "risk`whoami`end",
      interp: "x${process.env.SECRET}z",
      newline: "line one\nline two",
      crlf: "a\r\nb",
      quote: 'say "hi" now',
      allAtOnce: '`${\n}`"',
      nested: { deep: ["a`b", "c${d}e", "f\ng", 'q"r'] },
    },
  };

  function hostileModel(id: string): MigrationModel {
    return {
      modelVersion: "1",
      template: { id, title: "Hostile extraSpec", type: "service", extraSpec: hostileExtraSpec },
      questions: [{ name: "x", type: "string", page: "P" }],
    };
  }

  test("validation ACCEPTS hostile extraSpec values (exempt from the strict char rules)", () => {
    const r = validateModel(hostileModel("es-valid"));
    if (!r.valid) throw new Error(formatModelErrors(r.errors));
    expect(r.valid).toBe(true);
  });

  test("a non-object extraSpec is rejected by the schema", () => {
    const bad = hostileModel("es-bad") as unknown as { template: { extraSpec: unknown } };
    bad.template.extraSpec = "not an object";
    expect(validateModel(bad).valid).toBe(false);
  });

  test("the emitted file PARSES and the hostile values round-trip into the compiled spec", async () => {
    const model = hostileModel("es-roundtrip");
    expect(validateModel(model).valid).toBe(true);

    const ts = printTemplate(model).files["template.ts"];
    // Sanity: the values are emitted via lit() (double-quoted, JSON-escaped) — no bare
    // backtick or `${` at statement position could break out.
    expect(ts).toContain("extraSpec: {");

    // Import the emitted source back (this is the parse proof — a breakout would throw),
    // then compile it and confirm spec.catalog-metadata is the ORIGINAL object verbatim.
    const file = join(pkgTmp, "es-roundtrip.ts");
    await writeFile(file, ts, "utf8");
    const mod = (await import(`${file}?t=${Date.now()}`)) as { default: unknown };
    const { object } = await compileResolved(mod.default as never, { env: "test", outDir: "" });
    const spec = object.spec as Record<string, unknown>;
    expect(spec["catalog-metadata"]).toEqual(hostileExtraSpec["catalog-metadata"]);
  });
});

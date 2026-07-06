// Unit tests for ANSI stripping — the tiny helper that cleans Backstage's coloured log
// lines before the trace panel (a non-terminal) renders them.

import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./ansi.ts";

/** ESC, built from its code so the source carries no raw control byte. */
const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  test("removes the SGR colour codes Backstage emits around 'info'", () => {
    const line = `${ESC}[32minfo${ESC}[39m: Running debug:log`;
    expect(stripAnsi(line)).toBe("info: Running debug:log");
  });

  test("leaves a plain line untouched", () => {
    expect(stripAnsi("Starting up task with 3 steps")).toBe("Starting up task with 3 steps");
  });

  test("strips multiple sequences in one line", () => {
    const line = `${ESC}[1m${ESC}[31mERROR${ESC}[0m: the oven is cold`;
    expect(stripAnsi(line)).toBe("ERROR: the oven is cold");
  });

  test("does not eat the message text, only the escapes", () => {
    const line = `${ESC}[32mTicket: Order for Alice Baker — high priority (2 item(s))${ESC}[39m`;
    expect(stripAnsi(line)).toBe("Ticket: Order for Alice Baker — high priority (2 item(s))");
    expect(stripAnsi(line)).not.toContain(ESC);
  });

  test("an empty string stays empty", () => {
    expect(stripAnsi("")).toBe("");
  });
});

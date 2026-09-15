#!/usr/bin/env bun
/**
 * continuation-directive.test.ts — written BEFORE the implementation (TDD).
 *
 * The directive is the USER-FACING arming surface: saying "auto-continue for 2
 * hours" in a prompt grants that session a time-boxed licence. The keyword must
 * be SPECIFIC — merely mentioning or asking about auto-continue must never arm
 * anything, because an accidental grant is spent tokens and unattended turns,
 * while a missed grant costs one rephrase.
 */
import { expect, test, describe } from "bun:test";
import { parseAutoContinueDirective, DIRECTIVE_DEFAULT_MS, DIRECTIVE_MAX_MS, DIRECTIVE_DEFAULT_CAP, DIRECTIVE_MAX_CAP } from "./continuation-directive";

const NOW = 1_000_000;

describe("arming forms — keyword plus an explicit cue", () => {
  test("a duration arms for that window", () => {
    const d = parseAutoContinueDirective("auto-continue for 2 hours", NOW);
    expect(d).toEqual({ action: "arm", untilMs: NOW + 2 * 3_600_000, cap: DIRECTIVE_DEFAULT_CAP });
  });
  test("compact and minute forms parse", () => {
    expect(parseAutoContinueDirective("auto-continue for 90m", NOW)?.untilMs).toBe(NOW + 90 * 60_000);
    expect(parseAutoContinueDirective("autocontinue for 1h please", NOW)?.untilMs).toBe(NOW + 3_600_000);
    expect(parseAutoContinueDirective("auto continue for 45 minutes", NOW)?.untilMs).toBe(NOW + 45 * 60_000);
  });
  test("'until done' arms the default window", () => {
    const d = parseAutoContinueDirective("auto-continue until it's done", NOW);
    expect(d?.action).toBe("arm");
    expect(d?.untilMs).toBe(NOW + DIRECTIVE_DEFAULT_MS);
    expect(parseAutoContinueDirective("auto-continue until finished", NOW)?.action).toBe("arm");
    expect(parseAutoContinueDirective("please auto-continue until the work is complete", NOW)?.action).toBe("arm");
  });
  test("a bare 'auto-continue on' arms the default window", () => {
    expect(parseAutoContinueDirective("auto-continue on", NOW)?.untilMs).toBe(NOW + DIRECTIVE_DEFAULT_MS);
  });
  test("the directive can ride inside a longer instruction", () => {
    const d = parseAutoContinueDirective("run the whole migration, auto-continue for 3 hours, and log everything", NOW);
    expect(d?.untilMs).toBe(NOW + 3 * 3_600_000);
  });
  test("an explicit cap is honoured", () => {
    expect(parseAutoContinueDirective("auto-continue for 2h cap 10", NOW)?.cap).toBe(10);
    expect(parseAutoContinueDirective("auto-continue for 2h, up to 12 turns", NOW)?.cap).toBe(12);
  });
});

describe("clamps — a directive can ask, never exceed", () => {
  test("window clamps to the hard maximum", () => {
    expect(parseAutoContinueDirective("auto-continue for 99 hours", NOW)?.untilMs).toBe(NOW + DIRECTIVE_MAX_MS);
  });
  test("cap clamps to the hard maximum and floors at 1", () => {
    expect(parseAutoContinueDirective("auto-continue for 1h cap 999", NOW)?.cap).toBe(DIRECTIVE_MAX_CAP);
    expect(parseAutoContinueDirective("auto-continue for 1h cap 0", NOW)?.cap).toBe(DIRECTIVE_DEFAULT_CAP);
  });
  test("a zero or negative duration does not arm", () => {
    expect(parseAutoContinueDirective("auto-continue for 0 hours", NOW)).toBeNull();
  });
});

describe("off forms", () => {
  test.each([
    "auto-continue off",
    "auto-continue stop",
    "stop auto-continue",
    "cancel the auto-continue",
    "disable auto-continue now",
  ])("'%s' reads as off", (p) => {
    expect(parseAutoContinueDirective(p, NOW)).toEqual({ action: "off" });
  });
});

describe("NON-arming — mention is not consent", () => {
  test.each([
    "how does auto-continue work?",
    "what is auto-continue",
    "I think auto-continue caused that weird loop yesterday",
    "review the auto-continue code",
    "should we port auto-continue upstream?",
    "the auto-continue feature failed 57% of the time",
  ])("'%s' arms nothing", (p) => {
    expect(parseAutoContinueDirective(p, NOW)).toBeNull();
  });
  test("no keyword, no directive — duration language alone is inert", () => {
    expect(parseAutoContinueDirective("keep working for 2 hours", NOW)).toBeNull();
    expect(parseAutoContinueDirective("continue for 2 hours", NOW)).toBeNull();
  });
  test("a polite spoken request with an explicit duration still arms — voice users ask in questions", () => {
    expect(parseAutoContinueDirective("could you auto-continue for 2 hours?", NOW)?.untilMs).toBe(NOW + 2 * 3_600_000);
    expect(parseAutoContinueDirective("can you auto-continue for 30 minutes?", NOW)?.action).toBe("arm");
  });
  test("deliberation defuses, even with a duration — discussing is not directing", () => {
    expect(parseAutoContinueDirective("should we auto-continue for 2 hours?", NOW)).toBeNull();
    expect(parseAutoContinueDirective("would it be smart to auto-continue for 2 hours", NOW)).toBeNull();
    expect(parseAutoContinueDirective("is it worth it to auto-continue for 2h?", NOW)).toBeNull();
  });
  test("a question mark defuses the cue-less forms", () => {
    expect(parseAutoContinueDirective("auto-continue until done?", NOW)).toBeNull();
    expect(parseAutoContinueDirective("auto-continue on?", NOW)).toBeNull();
  });
  test("empty and garbage are inert", () => {
    expect(parseAutoContinueDirective("", NOW)).toBeNull();
    expect(parseAutoContinueDirective("   ", NOW)).toBeNull();
  });
});

#!/usr/bin/env bun
/**
 * ContinuationWiring.integration.test.ts — the feature's integration points fail
 * SILENTLY: every unit test stays green while the gate sits disconnected. These
 * tests read the SOURCE of the wiring and pin the properties that make the
 * feature live and safe, so an innocent refactor cannot quietly unplug it.
 */
import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const HOOKS = import.meta.dir;
const src = readFileSync(join(HOOKS, "ContinuationGate.hook.ts"), "utf-8");
const stopGates = readFileSync(join(HOOKS, "StopGates.hook.ts"), "utf-8");
const hooksJson = readFileSync(join(HOOKS, "hooks.json"), "utf-8");

describe("registration — an unregistered gate is not a gate", () => {
  test("StopGates imports and registers ContinuationGate", () => {
    expect(stopGates).toContain('from "./ContinuationGate.hook"');
    expect(stopGates).toContain('["ContinuationGate", continuationGate]');
  });

  test("ContinuationGate is registered LAST — every stop-reason outranks the one continue-reason", () => {
    const entries = [...stopGates.matchAll(/\["(\w+)",\s*\w+\]/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[entries.length - 1]).toBe("ContinuationGate");
  });

  test("StopGates arbitrates through gate-chain, where a block outranks earlier messages", () => {
    expect(stopGates).toContain('from "./lib/gate-chain"');
    expect(stopGates).not.toContain("if (d && !emitted)");
  });

  test("ContinuationArm is registered at UserPromptSubmit — the spoken front door exists", () => {
    const registered = JSON.parse(hooksJson);
    const ups = JSON.stringify(registered?.hooks?.UserPromptSubmit ?? []);
    expect(ups).toContain("ContinuationArm.hook.ts");
    // Sync on purpose: an async prompt hook cannot surface its confirmation message.
    const entry = (registered.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command?: string; async?: boolean }> }>)
      .flatMap((e) => e.hooks).find((h) => (h.command ?? "").includes("ContinuationArm"));
    expect(entry?.async).toBeUndefined();
  });
});

describe("the no-ISA path reaches sessions without a run", () => {
  test("no active run routes to the judge, it does not bail", () => {
    // Most sessions carry no ISA. Returning null here instead of calling the judge
    // is the single edit that would silently shrink this feature to ISA-bound runs,
    // with every unit test still green.
    expect(src).toContain("if (!active) return await runJudgePath(");
  });

  test("the cap is read from a FILE, so arming reaches running sessions", () => {
    expect(src).toContain("CAP_PATH");
    expect(src).toContain("readFile(CAP_PATH)");
  });

  test("the judge is consulted only AFTER every deterministic hand-back", () => {
    const asked = src.indexOf('why: "asks-principal"');
    const capCheck = src.indexOf('why: "cap-reached"');
    const judge = src.indexOf("askJudge(");
    expect(asked).toBeGreaterThan(-1);
    expect(capCheck).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(asked);
    expect(judge).toBeGreaterThan(capCheck);
  });
});

describe("loop safety — the counter is the breaker, and it must be read back", () => {
  test("the gate deliberately does not short-circuit on stop_hook_active — the counter bounds it instead", () => {
    // The header EXPLAINS the choice, so check for code usage, not the phrase.
    expect(src).not.toContain("input.stop_hook_active");
    expect(src).not.toMatch(/if\s*\(\s*[^)]*stop_hook_active/);
    expect(src).toContain("commitContinue(");
  });

  test("the cap is spent UNDER the state lock, not from a pre-lock read", () => {
    // Two Stop evaluations that both read count=0 outside any lock would both
    // continue past a cap of 1; the authoritative check must live in the locked
    // commit. Pin the shape: commitContinue re-checks the cap after acquiring.
    const body = src.slice(src.indexOf("function commitContinue"));
    const acquire = body.indexOf("acquireStateLock()");
    const capCheck = body.indexOf("count >= cap");
    expect(acquire).toBeGreaterThan(-1);
    expect(capCheck).toBeGreaterThan(acquire);
  });

  test("a counter that cannot persist refuses to continue", () => {
    expect(src).toContain("counter-not-persisted");
  });

  test("the kill switch is checked first", () => {
    const kill = src.indexOf("CONTINUATIONGATE_OFF");
    const decideBody = src.indexOf("last_assistant_message");
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(decideBody);
  });
});

describe("question triage — the deferral path must stay wired, and stay narrow", () => {
  const questions = readFileSync(join(HOOKS, "lib", "continuation-questions.ts"), "utf-8");

  test("the gate imports the triage module and calls it", () => {
    expect(src).toContain('from "./lib/continuation-questions"');
    expect(src).toContain("triageQuestion(");
  });

  test("BOTH paths triage prose — a fix applied to one path only is the classic miss", () => {
    expect(src.match(/triageQuestion\(/g)?.length).toBe(2);
  });

  test("a TOOL ask is never triaged — that veto stays absolute", () => {
    // Every triage call site must be guarded by the PROSE predicate, and the tool
    // veto must still return before any of them.
    for (const m of src.matchAll(/triageQuestion\(/g)) {
      const before = src.slice(Math.max(0, m.index! - 400), m.index!);
      expect(before).toContain("asked.inProse");
    }
    expect(src.indexOf('ask: "tool"')).toBeLessThan(src.indexOf("triageQuestion("));
  });

  test("triage runs only AFTER the budget checks — an over-cap turn spends no model call", () => {
    const cap = src.indexOf('why: "cap-reached"');
    const wall = src.indexOf('why: "wallclock-ceiling"');
    const triage = src.indexOf("triageQuestion(");
    expect(triage).toBeGreaterThan(cap);
    expect(triage).toBeGreaterThan(wall);
  });

  test("deferral is armed on its OWN key — arming a continuation cap must not arm deferral", () => {
    expect(questions).toContain("raw.questions");
    expect(questions).not.toContain("raw.all");
  });

  test("the write is locked, mutates from CURRENT entries, and is read back before the continue", () => {
    // withLedger(session, turn, mutate) is the only writer, it holds a lock, and the
    // mutator receives the CURRENT list — a pre-inference snapshot must never be written.
    expect(questions).toContain("function withLedger(");
    expect(questions).toContain("acquireLock()");
    const write = questions.indexOf("const wrote = withLedger(");
    const readback = questions.indexOf("const after = allPending(session);");
    const grant = questions.indexOf('why: "asks-principal-deferred"');
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(readback);
    expect(readback).toBeLessThan(grant);
  });

  test("the flush MARKS rendered rather than deleting — rendering is not delivery", () => {
    const flush = questions.slice(questions.indexOf("export function flushQuestionLedger"));
    expect(flush).toContain("rendered: stamp");
    // Decide-and-act in ONE locked pass; the clear only fires for entries already
    // rendered in an EARLIER human turn (renderedTurn), i.e. the principal has spoken.
    expect(flush).toContain("withLedger(session, humanTurn, (current)");
    expect(flush).toContain("renderedTurn !== humanTurn");
  });

  test("every non-deferring branch in the triage hands back", () => {
    for (const why of ["asks-principal-blocking", "shadow-would-defer", "question-ledger-full", "question-not-persisted"]) {
      const i = questions.indexOf(`why: "${why}"`);
      expect(i).toBeGreaterThan(-1);
      expect(questions.slice(i - 60, i)).toContain('verdict: "hand-back"');
    }
  });

  test("the ledger is flushed at run()'s single exit, so no `return null` can strand a question", () => {
    expect(src).toContain("flushQuestionLedger(");
    // run() delegates to decide() purely so the flush has one choke point.
    expect(src).toContain("async function decide(");
    expect(src.indexOf("export async function run(")).toBeLessThan(src.indexOf("async function decide("));
  });

  test("a continuation states the assumption it proceeded under", () => {
    expect(src.match(/assumptionClause\(deferredAssumption\)/g)?.length).toBe(2);
    // Normalize the template-literal concatenation ("do ` +\n  `NOT ask...") before
    // matching, so the assertion pins the INSTRUCTION rather than its line wrapping.
    const flat = questions.replace(/`\s*\+\s*`/g, "").replace(/\s+/g, " ");
    expect(flat).toMatch(/do NOT ask the question again/i);
    expect(flat).toMatch(/State that assumption plainly/i);
  });
});

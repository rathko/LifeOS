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

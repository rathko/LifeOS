#!/usr/bin/env bun
/**
 * gate-chain.test.ts — the arbitration rule, proven on its own.
 *
 * The rule exists because the old inline reducer in StopGates kept the FIRST
 * object any gate returned: a passive `systemMessage` from an early gate
 * silently swallowed a `decision:"block"` from any gate below it. These tests
 * pin the corrected precedence: a block from ANY gate wins, the first block
 * short-circuits, and a throwing gate never silences the gates after it.
 */
import { expect, test, describe } from "bun:test";
import { decide, type GateFn } from "./gate-chain";

const gate = (out: object | null): GateFn => async () => out;
const boom: GateFn = async () => { throw new Error("gate crashed"); };

describe("decide — block outranks everything", () => {
  test("a later block beats an earlier non-block message", async () => {
    const out = await decide(
      [["msg", gate({ systemMessage: "note" })], ["blk", gate({ decision: "block", reason: "stop" })]],
      {},
    );
    expect((out as { decision?: string }).decision).toBe("block");
  });

  test("the FIRST block short-circuits — later gates never run", async () => {
    let ran = false;
    const spy: GateFn = async () => { ran = true; return null; };
    const out = await decide(
      [["blk", gate({ decision: "block", reason: "first" })], ["spy", spy]],
      {},
    );
    expect((out as { reason?: string }).reason).toBe("first");
    expect(ran).toBe(false);
  });

  test("with no block, the first non-block object stands", async () => {
    const out = await decide(
      [["a", gate({ systemMessage: "first" })], ["b", gate({ systemMessage: "second" })]],
      {},
    );
    expect((out as { systemMessage?: string }).systemMessage).toBe("first");
  });

  test("all-null chains emit nothing", async () => {
    expect(await decide([["a", gate(null)], ["b", gate(null)]], {})).toBeNull();
  });

  test("a throwing gate never silences the gates after it", async () => {
    const out = await decide(
      [["boom", boom], ["blk", gate({ decision: "block", reason: "still heard" })]],
      {},
    );
    expect((out as { reason?: string }).reason).toBe("still heard");
  });

  test("a throwing gate does not discard an earlier message either", async () => {
    const out = await decide([["msg", gate({ systemMessage: "kept" })], ["boom", boom]], {});
    expect((out as { systemMessage?: string }).systemMessage).toBe("kept");
  });
});

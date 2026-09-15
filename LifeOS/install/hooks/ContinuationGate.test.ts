#!/usr/bin/env bun
/**
 * ContinuationGate.test.ts — proves the DANGEROUS case first.
 *
 * This is the only gate that can spend the principal's tokens on a decision they
 * did not make, so the tests that matter are the ones that prove it REFUSES: when
 * they were asked something, when the turn failed, when nothing was articulated,
 * when the counter cannot persist. The happy path is one test; the refusals are
 * the rest.
 */
import { expect, test, describe } from "bun:test";
import {
  asksPrincipal,
  evidenceClean,
  resolveCap,
  allSessionCap,
  nextOpenCriterion,
  run,
  acquireStateLock,
  releaseStateLock,
  activeGrant,
  resolveBudget,
  GRANT_HARD_CAP,
} from "./ContinuationGate.hook";
import type { TxEvent } from "./lib/transcript-evidence";

const ev = (over: Partial<TxEvent>): TxEvent => ({
  seq: 0, kind: "command", tool: "Bash", target: "x", resultText: "", isError: false, isCode: false, ...over,
});

describe("asksPrincipal — the case this gate exists for: a reply that asked NOTHING", () => {
  test("a reply that asked nothing is continuable", () => {
    expect(asksPrincipal("Wrote the parser and the tests pass. Next up is the merger.")).toBe(false);
  });
  test("a plain question hands back", () => {
    expect(asksPrincipal("Wrote the parser. Do you want the merger next?")).toBe(true);
  });
  test("question-free permission phrasing still counts", () => {
    expect(asksPrincipal("Parser is in. Let me know which option you want.")).toBe(true);
    expect(asksPrincipal("Staged and ready, awaiting your approval.")).toBe(true);
    expect(asksPrincipal("I can go either way here, your call.")).toBe(true);
  });
  test("a question inside a code block does NOT count", () => {
    expect(asksPrincipal("Added the prompt:\n```\nconst q = 'Do you want to continue?'\n```\nTests pass.")).toBe(false);
  });
  test("a quoted question from a doc does NOT count", () => {
    expect(asksPrincipal("The spec line reads:\n> Should the cap be five?\n\nImplemented as five.")).toBe(false);
  });
});

describe("evidenceClean — a failing or chatty turn ends the streak", () => {
  test("clean tool work continues", () => {
    expect(evidenceClean([ev({ kind: "edit" }), ev({ kind: "test-run", seq: 1 })]).ok).toBe(true);
  });
  test("no tool calls at all hands back", () => {
    expect(evidenceClean([]).ok).toBe(false);
    expect(evidenceClean([]).why).toBe("no-tool-evidence");
  });
  test("a user-text-only turn hands back", () => {
    expect(evidenceClean([ev({ kind: "user-text" })]).ok).toBe(false);
  });
  test("any erroring event hands back — retry loops are not this gate's job", () => {
    expect(evidenceClean([ev({ kind: "edit" }), ev({ kind: "command", seq: 1, isError: true })]).ok).toBe(false);
    expect(evidenceClean([ev({ isError: true })]).why).toBe("turn-had-errors");
  });
});

describe("resolveCap — shadow is the default; ISA frontmatter > cap file > env", () => {
  /** No cap file on disk. Every test passes a stub so the suite never reads the real one. */
  const noFile = () => { throw new Error("ENOENT"); };
  const file = (json: string) => () => json;

  test("nothing set = shadow", () => {
    expect(resolveCap(null, {} as NodeJS.ProcessEnv, noFile)).toBe(0);
  });
  test("env arms it when there is no file", () => {
    expect(resolveCap(null, { LIFEOS_AUTOCONTINUE_MAX: "3" } as any, noFile)).toBe(3);
  });
  test("ISA frontmatter beats env", () => {
    expect(resolveCap({ autocontinue: "2" }, { LIFEOS_AUTOCONTINUE_MAX: "5" } as any, noFile)).toBe(2);
  });
  test("clamped to the hard cap", () => {
    expect(resolveCap({ autocontinue: "999" }, {} as any, noFile)).toBe(8);
  });
  test("garbage and negatives fall back to shadow", () => {
    expect(resolveCap({ autocontinue: "yes" }, {} as any, noFile)).toBe(0);
    expect(resolveCap({ autocontinue: "-4" }, {} as any, noFile)).toBe(0);
    expect(resolveCap({ autocontinue: "0" }, {} as any, noFile)).toBe(0);
  });
  test("cap file arms the ISA path with no ISA frontmatter and no env", () => {
    expect(resolveCap(null, {} as any, file('{"isa":3}'))).toBe(3);
  });
  test("cap file beats env, because a file reaches sessions already running", () => {
    expect(resolveCap(null, { LIFEOS_AUTOCONTINUE_MAX: "1" } as any, file('{"isa":4}'))).toBe(4);
  });
  test("an ISA's own frontmatter still outranks the standing cap", () => {
    expect(resolveCap({ autocontinue: "2" }, {} as any, file('{"isa":8}'))).toBe(2);
  });
  test("frontmatter 0 pins that ISA to shadow even when the file is armed", () => {
    expect(resolveCap({ autocontinue: "0" }, {} as any, file('{"isa":5}'))).toBe(0);
  });
  test("the no-ISA `all` key does NOT arm the ISA path", () => {
    expect(resolveCap(null, {} as any, file('{"all":3}'))).toBe(0);
  });
  test("file cap is clamped to the hard cap", () => {
    expect(resolveCap(null, {} as any, file('{"isa":99}'))).toBe(8);
  });
  test("malformed file falls through to env rather than throwing", () => {
    expect(resolveCap(null, { LIFEOS_AUTOCONTINUE_MAX: "2" } as any, file("{not json"))).toBe(2);
  });
  test("a non-numeric isa key is ignored, not coerced", () => {
    expect(resolveCap(null, {} as any, file('{"isa":"3"}'))).toBe(0);
  });
});

describe("allSessionCap — the no-ISA knob is separate, off by default", () => {
  const noFile = () => { throw new Error("ENOENT"); };
  const file = (json: string) => () => json;

  test("nothing set = off", () => {
    expect(allSessionCap(noFile, {} as NodeJS.ProcessEnv)).toBe(0);
  });
  test("the cap file arms it, live", () => {
    expect(allSessionCap(file('{"all":3}'), {} as any)).toBe(3);
  });
  test("file beats env, so arming reaches sessions already running", () => {
    expect(allSessionCap(file('{"all":4}'), { LIFEOS_AUTOCONTINUE_ALL: "1" } as any)).toBe(4);
  });
  test("arming the ISA key does NOT arm the no-ISA path", () => {
    expect(allSessionCap(file('{"isa":5}'), {} as any)).toBe(0);
  });
  test("clamped to the hard cap; garbage is off", () => {
    expect(allSessionCap(file('{"all":99}'), {} as any)).toBe(8);
    expect(allSessionCap(file('{"all":"3"}'), {} as any)).toBe(0);
    expect(allSessionCap(file('{"all":-2}'), {} as any)).toBe(0);
  });
});

describe("nextOpenCriterion — the continuation turn gets a target, not a vibe", () => {
  const isa = `## ISC Criteria\n\n- [x] C1: parser lands\n- [ ] C2: merger dedupes by path\n- [ ] C3: CLI wired\n`;
  test("returns the first unchecked criterion", () => {
    expect(nextOpenCriterion(isa)).toContain("merger dedupes by path");
  });
  test("returns null when everything is closed", () => {
    expect(nextOpenCriterion(`## ISC Criteria\n\n- [x] C1: done\n`)).toBeNull();
  });
});

// Negative cases first and in bulk: a grant is the only thing here that BUYS
// autonomy, so every ambiguous input must read as "no grant", never a generous one.
describe("activeGrant — fail-closed licence reading", () => {
  const S = "sess-1";
  const grant = (o: Record<string, unknown>) => JSON.stringify({ grant: { session: S, cap: 40, untilMs: 2_000, ...o } });

  test("a live grant for this session is returned", () => {
    expect(activeGrant(grant({}), S, 1_000)?.cap).toBe(40);
  });
  test("EXPIRY: at or past untilMs reads as no grant — the failure mode is always less autonomy", () => {
    expect(activeGrant(grant({}), S, 2_000)).toBeNull();
    expect(activeGrant(grant({}), S, 9_999)).toBeNull();
  });
  test("a grant never crosses sessions", () => {
    expect(activeGrant(grant({}), "other-session", 1_000)).toBeNull();
  });
  test("malformed, missing or absent grants all read as null, never as unlimited", () => {
    expect(activeGrant("{}", S, 1_000)).toBeNull();
    expect(activeGrant("{{{", S, 1_000)).toBeNull();
    expect(activeGrant("", S, 1_000)).toBeNull();
    expect(activeGrant(grant({ untilMs: "soon" }), S, 1_000)).toBeNull();
    expect(activeGrant(grant({ cap: 0 }), S, 1_000)).toBeNull();
    expect(activeGrant(grant({ cap: "lots" }), S, 1_000)).toBeNull();
  });
  test("an over-large grant is clamped, not honoured as asked", () => {
    expect(activeGrant(grant({ cap: 9_999 }), S, 1_000)?.cap).toBe(GRANT_HARD_CAP);
  });
});

describe("resolveBudget — a grant only ever raises", () => {
  const S = "sess-1";
  const env = {} as NodeJS.ProcessEnv;

  test("with no grant it is the standing cap and default ceiling", () => {
    const b = resolveBudget(S, () => '{"all":3}', env, 1_000);
    expect(b.cap).toBe(3);
    expect(b.maxMs).toBe(45 * 60 * 1000);
    expect(b.grant).toBeNull();
  });
  test("a live grant raises the cap and stretches the ceiling to its window", () => {
    const raw = JSON.stringify({ all: 3, grant: { session: S, cap: 25, untilMs: 8 * 3_600_000 } });
    const b = resolveBudget(S, () => raw, env, 1_000);
    expect(b.cap).toBe(25);
    expect(b.maxMs).toBeGreaterThan(45 * 60 * 1000);
    expect(b.grant).not.toBeNull();
  });
  test("a hand-armed standing cap larger than the grant is not demoted", () => {
    const raw = JSON.stringify({ all: 8, grant: { session: S, cap: 2, untilMs: 9_999_999 } });
    expect(resolveBudget(S, () => raw, env, 1_000).cap).toBe(8);
  });
  test("an unreadable cap file falls back to the standing budget, not to a grant", () => {
    const b = resolveBudget(S, () => { throw new Error("gone"); }, env, 1_000);
    expect(b.grant).toBeNull();
  });
});

describe("state lock — contention refuses, staleness breaks", () => {
  // These run against the install's real lock path. That is safe by construction:
  // releaseStateLock is owner-token verified (it cannot release another process's
  // lock), and if a LIVE gate holds the lock right now the correct behavior is the
  // one asserted anyway — acquisition refuses. In that rare case the test yields
  // rather than asserting on someone else's lock.
  test("a held lock refuses a second acquisition; release frees it", () => {
    releaseStateLock();                       // ours only — a foreign lock survives this
    if (!acquireStateLock()) return;          // live contention: refusing IS the contract
    expect(acquireStateLock()).toBe(false);   // second writer REFUSES — hand-back, not a race
    releaseStateLock();
    expect(acquireStateLock()).toBe(true);    // freed
    releaseStateLock();
  });

  test("a provably stale lock (crashed holder) is broken rather than deadlocking forever", () => {
    releaseStateLock();
    if (!acquireStateLock()) return;          // live contention: skip, per above
    // Simulate the crashed holder by asking from a future clock beyond the stale window.
    expect(acquireStateLock(Date.now() + 60_000)).toBe(true);
    releaseStateLock();
  });
});

describe("run — fail-safe boundaries", () => {
  test("kill switch hands back", async () => {
    process.env.CONTINUATIONGATE_OFF = "1";
    const out = await run({ last_assistant_message: "work done", session_id: "s" } as any);
    delete process.env.CONTINUATIONGATE_OFF;
    expect(out).toBeNull();
  });
  test("no message hands back", async () => {
    expect(await run({ session_id: "s" } as any)).toBeNull();
  });
  test("no session id hands back", async () => {
    expect(await run({ last_assistant_message: "x" } as any)).toBeNull();
  });
  test("unknown session with nothing armed hands back", async () => {
    const out = await run({
      last_assistant_message: "Parser landed, tests pass.",
      session_id: "definitely-not-a-real-session-uuid",
      transcript_path: "/nonexistent/transcript.jsonl",
    } as any);
    expect(out).toBeNull();
  });
});

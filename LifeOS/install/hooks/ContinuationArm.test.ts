#!/usr/bin/env bun
/**
 * ContinuationArm.test.ts — the arming write path, against a temp cap file.
 *
 * The dangerous property to pin: arming MERGES (the standing isa/all keys and
 * someone else's nothing must survive), confirms only what read-back proves, and
 * "off" revokes without collateral damage.
 */
import { expect, test, describe } from "bun:test";
import { applyDirective, liveGrantFor } from "./ContinuationArm.hook";
import { readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "cg-arm-"));
const capAt = (name: string) => join(dir, name + ".json");

describe("applyDirective — arm", () => {
  test("arms a session-scoped grant and confirms from read-back", () => {
    const p = capAt("fresh");
    const msg = applyDirective({ action: "arm", untilMs: Date.now() + 3_600_000, cap: 25 }, "sess-1", p);
    expect(msg).toContain("armed for THIS session");
    const on = JSON.parse(readFileSync(p, "utf-8"));
    expect(on.grant.session).toBe("sess-1");
    expect(on.grant.cap).toBe(25);
  });

  test("MERGES: standing caps survive an arming write", () => {
    const p = capAt("merge");
    writeFileSync(p, JSON.stringify({ isa: 3, all: 2 }));
    applyDirective({ action: "arm", untilMs: Date.now() + 3_600_000, cap: 10 }, "sess-2", p);
    const on = JSON.parse(readFileSync(p, "utf-8"));
    expect(on.isa).toBe(3);
    expect(on.all).toBe(2);
    expect(on.grant.cap).toBe(10);
  });

  test("the cap file is private after the write, even when it pre-existed looser", () => {
    const p = capAt("perms");
    writeFileSync(p, "{}", { mode: 0o664 });
    applyDirective({ action: "arm", untilMs: Date.now() + 3_600_000, cap: 5 }, "sess-3", p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("applyDirective — off", () => {
  test("revokes the grant and leaves standing caps alone", () => {
    const p = capAt("off");
    writeFileSync(p, JSON.stringify({ all: 3, grant: { session: "s", cap: 9, untilMs: Date.now() + 9_999 } }));
    const msg = applyDirective({ action: "off" }, "s", p);
    expect(msg).toContain("revoked");
    const on = JSON.parse(readFileSync(p, "utf-8"));
    expect(on.grant).toBeUndefined();
    expect(on.all).toBe(3);
  });

  test("off with nothing active says so instead of pretending", () => {
    const p = capAt("off-empty");
    expect(applyDirective({ action: "off" }, "s", p)).toContain("no licence");
  });
});

// ── Reviewer-requested pins (Martins Zaumanis, 2026-10-01) ───────────────────
describe("bare-stop revocation and session isolation", () => {
  test("a bare 'stop' revokes a LIVE grant for that session", () => {
    const dir = mkdtempSync(join(tmpdir(), "arm-stop-"));
    const cap = join(dir, "continuation-cap.json");
    writeFileSync(cap, JSON.stringify({ grant: { session: "s1", cap: 25, untilMs: Date.now() + 3_600_000 } }));
    expect(liveGrantFor("s1", cap)).toBe(true);
    // Another session's grant is not this session's business.
    expect(liveGrantFor("s2", cap)).toBe(false);
    // An expired grant is indistinguishable from no grant.
    writeFileSync(cap, JSON.stringify({ grant: { session: "s1", cap: 25, untilMs: Date.now() - 1 } }));
    expect(liveGrantFor("s1", cap)).toBe(false);
    expect(liveGrantFor("s1", join(dir, "absent.json"))).toBe(false);
  });

  test("a grant written by one session never leaks into another", () => {
    // His install's first version shared one state file, and within the hour a
    // parallel window picked up another window's target. Pinned here so the
    // session-scoped shape cannot regress quietly.
    const dir = mkdtempSync(join(tmpdir(), "arm-iso-"));
    const cap = join(dir, "continuation-cap.json");
    applyDirective({ action: "arm", untilMs: Date.now() + 7_200_000, cap: 25 }, "session-A", cap);
    const grant = JSON.parse(readFileSync(cap, "utf-8")).grant;
    expect(grant.session).toBe("session-A");
    expect(liveGrantFor("session-B", cap)).toBe(false);
    // Arming B replaces the grant rather than granting both — one live grant, and it
    // belongs to whoever spoke last.
    applyDirective({ action: "arm", untilMs: Date.now() + 7_200_000, cap: 25 }, "session-B", cap);
    expect(JSON.parse(readFileSync(cap, "utf-8")).grant.session).toBe("session-B");
    expect(liveGrantFor("session-A", cap)).toBe(false);
  });
});

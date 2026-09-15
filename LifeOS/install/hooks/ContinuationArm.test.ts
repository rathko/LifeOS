#!/usr/bin/env bun
/**
 * ContinuationArm.test.ts — the arming write path, against a temp cap file.
 *
 * The dangerous property to pin: arming MERGES (the standing isa/all keys and
 * someone else's nothing must survive), confirms only what read-back proves, and
 * "off" revokes without collateral damage.
 */
import { expect, test, describe } from "bun:test";
import { applyDirective } from "./ContinuationArm.hook";
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

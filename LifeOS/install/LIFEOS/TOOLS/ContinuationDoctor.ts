#!/usr/bin/env bun
/**
 * ContinuationDoctor — "is the auto-continue actually working?" in one command.
 *
 * The ContinuationGate's integration points fail SILENTLY — every unit test stays
 * green while the feature sits disconnected — so this tool answers the only useful
 * question: what is provably live right now.
 *
 * Also the arm/disarm control: `--arm N` writes a cap FILE the hook re-reads every
 * Stop, so it reaches sessions already running with no restart. That is also why
 * the file outranks env: `settings.json` env is read once at session start and
 * strands every open window.
 *
 * Usage:
 *   bun ContinuationDoctor.ts              # human report
 *   bun ContinuationDoctor.ts --json       # machine readable
 *   bun ContinuationDoctor.ts --arm 3      # arm the no-ISA path, live, no restart
 *   bun ContinuationDoctor.ts --off        # disarm it
 *   bun ContinuationDoctor.ts --arm-isa 3  # arm the ISA path's standing cap, live
 *   bun ContinuationDoctor.ts --off-isa    # back to shadow
 *
 * Exit codes: 0 = wiring intact, 1 = a wiring check failed (the upgrade tripwire).
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CLAUDE = join(homedir(), ".claude");
const HOOKS = join(CLAUDE, "hooks");
const LIFEOS = process.env.LIFEOS_DIR || join(CLAUDE, "LIFEOS");
const VERDICTS = join(LIFEOS, "MEMORY", "OBSERVABILITY", "continuation-gate.jsonl");
const CAP_PATH = join(LIFEOS, "MEMORY", "STATE", "continuation-cap.json");

const read = (p: string): string => { try { return readFileSync(p, "utf-8"); } catch { return ""; } };

function currentCap(): number {
  try {
    const o = JSON.parse(read(CAP_PATH));
    if (o && typeof o.all === "number") return o.all;
  } catch { /* fall through */ }
  return Number(process.env.LIFEOS_AUTOCONTINUE_ALL ?? "0") || 0;
}

/** Standing cap for ISA-bound sessions. Mirrors the gate's file-then-env order. */
function currentIsaCap(): number {
  try {
    const o = JSON.parse(read(CAP_PATH));
    if (o && typeof o.isa === "number") return o.isa;
  } catch { /* fall through */ }
  return Number(process.env.LIFEOS_AUTOCONTINUE_MAX ?? "0") || 0;
}

/**
 * Arm or disarm one path. MERGES rather than overwrites: the file also carries the
 * other path's cap, and a whole-object write would silently revoke it.
 */
function setCap(n: number, key: "all" | "isa" = "all"): void {
  mkdirSync(dirname(CAP_PATH), { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(read(CAP_PATH)) ?? {}; } catch { /* start fresh */ }
  existing[key] = n;
  // 0600: arming is a privilege decision — on a shared-group install a group-writable
  // cap file would let another account raise autonomy without touching hook code.
  // The explicit chmod matters because fs mode options only apply on CREATE; a
  // pre-existing looser file would otherwise keep its old permissions forever.
  writeFileSync(CAP_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
  chmodSync(CAP_PATH, 0o600);
  const label = key === "all" ? "no-ISA path" : "ISA path standing cap";
  console.log(n > 0
    ? `✅ Armed the ${label}: up to ${n} auto-continue${n === 1 ? "" : "s"} per run. Live in every open session on its next turn.`
    : `⭕ ${label} back to ${key === "all" ? "off" : "shadow"}. Live in every open session on its next turn.`);
}

const armIsaIdx = process.argv.indexOf("--arm-isa");
if (armIsaIdx > -1) {
  const n = Number(process.argv[armIsaIdx + 1]);
  if (!Number.isFinite(n) || n < 0) { console.error("usage: --arm-isa <0-8>"); process.exit(2); }
  setCap(Math.min(Math.floor(n), 8), "isa");
  process.exit(0);
}
if (process.argv.includes("--off-isa")) { setCap(0, "isa"); process.exit(0); }

const armIdx = process.argv.indexOf("--arm");
if (armIdx > -1) {
  const n = Number(process.argv[armIdx + 1]);
  if (!Number.isFinite(n) || n < 0) { console.error("usage: --arm <0-8>"); process.exit(2); }
  setCap(Math.min(Math.floor(n), 8));
  process.exit(0);
}
if (process.argv.includes("--off")) { setCap(0); process.exit(0); }

interface Check { name: string; ok: boolean; detail: string }

/** The same integration points ContinuationWiring.integration.test.ts guards. Checked
 * here too so a human can ask the question without running a test suite. */
function wiringChecks(): Check[] {
  const stop = read(join(HOOKS, "StopGates.hook.ts"));
  const gate = read(join(HOOKS, "ContinuationGate.hook.ts"));
  const entries = [...stop.matchAll(/\["([A-Za-z]+)",\s*[a-zA-Z]+\]/g)].map((m) => m[1]);

  return [
    { name: "ContinuationGate exists", ok: !!gate, detail: gate ? "present" : "MISSING" },
    { name: "registered in StopGates", ok: stop.includes('["ContinuationGate", continuationGate]'), detail: "chain entry" },
    { name: "registered LAST in chain", ok: entries.at(-1) === "ContinuationGate", detail: `order: ${entries.join(" → ") || "none"}` },
    { name: "chain arbitration extracted", ok: stop.includes("decide(GATES, input)"), detail: "lib/gate-chain.ts (a block outranks earlier messages)" },
    { name: "no-ISA sessions routed to the judge", ok: gate.includes("if (!active) return await runJudgePath("), detail: "most sessions depend on this line" },
    { name: "cap read from file, not just env", ok: gate.includes("readFile(CAP_PATH)"), detail: "so arming reaches sessions already running" },
  ];
}

function verdictHistogram(): { total: number; byWhy: Record<string, number>; lastTs: string } {
  const raw = read(VERDICTS);
  const byWhy: Record<string, number> = {};
  let total = 0, lastTs = "never";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      byWhy[r.why ?? "?"] = (byWhy[r.why ?? "?"] ?? 0) + 1;
      total++;
      if (r.ts) lastTs = r.ts;
    } catch { /* skip */ }
  }
  return { total, byWhy, lastTs };
}

const wiring = wiringChecks();
const verdicts = verdictHistogram();
const wiringOk = wiring.every((c) => c.ok);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ wiringOk, wiring, verdicts }, null, 2));
  process.exit(wiringOk ? 0 : 1);
}

const mark = (ok: boolean) => (ok ? "✅" : "❌");
console.log("\n═══ ContinuationGate — auto-continue ═══\n");

console.log("WIRING (fails loudly if an upgrade dropped the registration)");
for (const c of wiring) console.log(`  ${mark(c.ok)} ${c.name.padEnd(38)} ${c.detail}`);

console.log("\nVERDICTS");
console.log(`  logged: ${verdicts.total}  (last: ${verdicts.lastTs})`);
for (const [why, n] of Object.entries(verdicts.byWhy).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(5)}  ${why}`);
}

const isaCap = currentIsaCap();
console.log("\nISA PATH — needs an active run; open ISC criteria answer \"finished?\"");
console.log(`  ${isaCap > 0 ? "✅ ARMED" : "⭕ shadow"}  standing cap=${isaCap}${isaCap > 0 ? " (an ISA's own `autocontinue:` overrides it)" : "  → arm to act on verdicts"}`);
console.log("  arm/disarm live, no restart: bun ContinuationDoctor.ts --arm-isa 3 | --off-isa");
const wouldHave = verdicts.byWhy["shadow-would-continue"] ?? 0;
console.log(wouldHave > 0
  ? `  → ${wouldHave} turn(s) it would have continued while in shadow.`
  : "  → no would-have-continued turns yet; every verdict so far was a hand-back.");

// Live grant, if any — the "auto-continue for 2 hours" utterance surface.
try {
  const g = JSON.parse(read(CAP_PATH))?.grant;
  if (g && typeof g.untilMs === "number") {
    const live = Date.now() < g.untilMs;
    console.log(`\nGRANT — spoken licence ("auto-continue for 2h" in a prompt; ContinuationArm hook)`);
    console.log(`  ${live ? "✅ LIVE " : "⭕ expired"}  session=${String(g.session).slice(0, 12)}…  cap=${g.cap}  until=${new Date(g.untilMs).toISOString()}`);
    console.log(`  revoke by saying "auto-continue off" in that session`);
  }
} catch { /* no grant to show */ }

const allCap = currentCap();
console.log("\nNO-ISA PATH — a judge answers \"finished?\" for sessions without a run");
console.log(`  ${allCap > 0 ? "✅ ARMED" : "⭕ off "}  cap=${allCap}${allCap > 0 ? ` (${allCap} continues per session, reset when you speak)` : "  → off: no verdicts computed, no model called"}`);
console.log("  judge: LIFEOS/TOOLS/Inference.ts --level low; only an explicit finished:false continues");
console.log("  arm/disarm live, no restart: bun ContinuationDoctor.ts --arm 3 | --off");
console.log("  hard kill: CONTINUATIONGATE_OFF=1");

process.exit(wiringOk ? 0 : 1);

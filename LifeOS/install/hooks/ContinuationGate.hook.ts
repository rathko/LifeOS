#!/usr/bin/env bun
/**
 * ContinuationGate.hook.ts — the throughput gate (Stop).
 *
 * Every other gate in the StopGates chain is a reason to STOP. This one is the
 * only reason to KEEP GOING, and it exists because of a measurement, not a hunch:
 * across 1,605 human turns over 30 days on a live install, 12.1% were a bare
 * "go" — and 91% of those followed a message that had asked the principal nothing
 * at all. They were not answering a question. They were restarting a turn that
 * ended because the harness always ends turns. Median dead time before one of
 * those restarts: 357s.
 *
 * So this gate does NOT auto-approve decisions. It answers one narrow question —
 * "is the declared work actually finished?" — and if it provably is not, it hands
 * the run one more turn instead of handing it back to the principal.
 *
 * CONTINUE iff ALL hold; any failure ⇒ HAND BACK (the default, which is exactly
 * today's behavior — the failure mode of every bug in this file is the status quo):
 *   1. armed with a positive cap (ISA frontmatter `autocontinue:`, the cap file,
 *      or env). Cap 0 = SHADOW: verdict computed and logged, never acted on, and
 *      on the no-ISA path no model is ever called. Shadow is the default.
 *   2. the session is bound to an active run in work.json (phase ≠ complete),
 *      OR the no-ISA path is armed separately (its own key, never by accident)
 *   3. that run's ISA has articulated criteria and ≥1 is still open — or, with no
 *      ISA, a judge answers "finished?" (lib/continuation-judge.ts) and only an
 *      explicit `finished:false` continues
 *   4. the turn produced real tool evidence, none of it erroring
 *      (a failing turn is a different problem class — not this gate's job)
 *   5. the reply asked the principal nothing: no AskUserQuestion call, no
 *      question in prose (conservative on purpose — a false "they were asked"
 *      costs one hand-back; a false "they weren't" spends tokens on a decision
 *      the principal never made)
 *   6. the run is under its consecutive-continue cap AND its wall-clock ceiling
 *
 * LOOP SAFETY. Unlike every sibling gate, this one deliberately does NOT
 * short-circuit on `stop_hook_active` — a one-hop-only continuation would be
 * pointless. The loop breaker is instead the per-run counter, which is written
 * and READ BACK before any block is emitted: if the counter cannot be persisted,
 * the gate refuses to continue. Belt and braces: a wall-clock ceiling, a hard
 * cap, and the tool-evidence precondition (a chatty no-tool turn ends the streak
 * by itself). The counter resets whenever a new human turn appears in the
 * transcript, which is what makes "3 per run" mean 3 since the principal last
 * spoke. Concurrent Stop evaluations are serialized by an exclusive-create
 * lockfile around the counter commit; a contended lock refuses to continue, so
 * the failure direction of every race is a hand-back, never a double continue.
 *
 * TWO PATHS:
 *   ISA path    — a run is bound: open ISC criteria answer "is it finished?".
 *   NO-ISA path — no run bound: a JUDGE answers it instead. Most sessions land
 *                 here. The same deterministic gates run first; the judge is only
 *                 consulted on turns that already passed them, and only an
 *                 explicit `finished:false` continues.
 *
 * Kill switch: CONTINUATIONGATE_OFF=1.
 * Cap (ISA):    ISA `autocontinue: N`, else cap-file `isa`, else LIFEOS_AUTOCONTINUE_MAX
 *               (default 0 = shadow). File before env so arming reaches running sessions.
 * Cap (no-ISA): cap-file `all`, else LIFEOS_AUTOCONTINUE_ALL (default 0 = off).
 *               Separate keys on purpose — the two paths must never be armed by
 *               accident through one variable.
 * Ceiling:   LIFEOS_AUTOCONTINUE_MAX_MS (default 45min per run).
 * Fail toward hand-back on any read/parse error — the gate must never be why a
 * Stop breaks, and must never be why a session runs away.
 *
 * Arm/disarm/inspect: `bun LIFEOS/TOOLS/ContinuationDoctor.ts` (live, no restart).
 *
 * TRIGGER: Stop (evaluated inside StopGates.hook.ts, LAST — every stop-reason wins over it)
 */

// Type-only import of HookInput; `readHookInput` is pulled in dynamically by the
// standalone shim below: hook-io reaches TranscriptParser → identity → `yaml`, which
// resolves under `bun run` but not under `bun test`. Keeping the value import out of
// the module graph is what makes this gate's logic unit-testable, and it is the right
// shape anyway — the gate is pure decision logic, only the shim needs stdin.
import type { HookInput } from "./lib/hook-io";
import { parseTurnEvents, type TxEvent } from "./lib/transcript-evidence";
import { findActiveSessionByUUID, findArtifactPath, countCriteria, parseCriteriaList, parseFrontmatter } from "./lib/isa-utils";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { askJudge } from "./lib/continuation-judge";

const LIFEOS = process.env.LIFEOS_DIR || join(process.env.HOME!, ".claude", "LIFEOS");
const OBS_PATH = join(LIFEOS, "MEMORY", "OBSERVABILITY", "continuation-gate.jsonl");
const STATE_PATH = join(LIFEOS, "MEMORY", "STATE", "continuation-gate.json");
/** Live cap file — re-read every Stop, so arming reaches running sessions with no restart. */
export const CAP_PATH = join(LIFEOS, "MEMORY", "STATE", "continuation-cap.json");

const DEFAULT_CAP = 0;                       // shadow until explicitly armed
const DEFAULT_MAX_MS = 45 * 60 * 1000;       // 45 minutes of unattended run
const HARD_CAP = 8;                          // no ISA may ask for more than this

/** The principal's name, for the continuation messages. Resolved lazily so the
 * unit tests (which never emit a continuation) don't drag the identity graph in. */
async function principalName(): Promise<string> {
  try {
    const { getPrincipalName } = await import("./lib/identity");
    return getPrincipalName() || "the principal";
  } catch { return "the principal"; }
}

// ── Pure predicates (exported for tests) ─────────────────────────────────────

/** Fenced code, inline code and blockquote lines are not the author speaking. */
export function stripNoise(msg: string): string {
  return msg
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ");
}

/** Everything the author actually says is askable prose — only code, quotes and
 * HTML comments are stripped. A question asked in a closing summary still counts. */
export function askableProse(message: string): string {
  return stripNoise(message).replace(/<!--[\s\S]*?-->/g, " ");
}

/** Any genuine question put to the principal. Conservative on purpose: a false
 * "they were asked" costs one hand-back; a false "they weren't" spends their
 * tokens on a decision they never made. English-centric by construction — a
 * localized install should extend the phrase list, and the miss cost is bounded
 * by the cap either way. */
export function asksPrincipal(message: string): boolean {
  const prose = askableProse(message);
  if (/\?/.test(prose)) return true;
  return /\b(shall I|should I|do you want|would you like|want me to|let me know|your call|up to you|which (one|option|way)|pick one|confirm (this|that|before)|say the word|tell me (if|which|whether)|awaiting|waiting (on|for) (you|your)|need(s)? your (input|decision|approval|sign[- ]?off))\b/i.test(prose);
}

/** Real work happened this turn, and nothing in it failed. A no-tool turn is
 * conversation; a failing turn belongs to a retry-loop problem, not here. "Tool
 * evidence" is every transcript event except the user's own text; "clean" is the
 * harness's own isError flag on each event. */
export function evidenceClean(ev: TxEvent[]): { ok: boolean; why: string } {
  const work = ev.filter((e) => e.kind !== "user-text");
  if (work.length === 0) return { ok: false, why: "no-tool-evidence" };
  if (work.some((e) => e.isError)) return { ok: false, why: "turn-had-errors" };
  return { ok: true, why: `${work.length} clean tool events` };
}

/**
 * Cap for a session WITH an ISA bound. Precedence, first hit wins:
 *   1. the ISA's own `autocontinue:` frontmatter — a deliberate per-project statement
 *   2. the cap FILE's `isa` key — the standing default, re-read every Stop
 *   3. `LIFEOS_AUTOCONTINUE_MAX` — bootstrap default on a machine with no file yet
 * All clamped to [0, HARD_CAP]; 0 keeps the path in shadow.
 *
 * FILE BEFORE ENV: a hook is spawned fresh on every Stop, so a file reaches
 * sessions already open, while `settings.json` env is read once at session start
 * and strands every running window.
 *
 * `isa` and `all` are separate keys so the two paths can never be armed through one knob.
 */
export function resolveCap(
  frontmatter: Record<string, string> | null,
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): number {
  const clamp = (raw: unknown): number => {
    const n = Number(String(raw ?? "").trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), HARD_CAP);
  };
  if (frontmatter?.autocontinue !== undefined) return clamp(frontmatter.autocontinue);
  try {
    const raw = JSON.parse(readFile(CAP_PATH));
    if (raw && typeof raw === "object" && typeof raw.isa === "number") return clamp(raw.isa);
  } catch { /* absent or malformed ⇒ fall through to env */ }
  return clamp(env.LIFEOS_AUTOCONTINUE_MAX ?? String(DEFAULT_CAP));
}

/**
 * Cap for sessions with no ISA. Separate from the ISA path's key so the two can
 * never be armed by accident through one knob, and 0 (off) unless armed.
 * Written by `ContinuationDoctor.ts --arm N` / `--off`.
 */
export function allSessionCap(
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_CAP) : 0);
  try {
    const raw = JSON.parse(readFile(CAP_PATH));
    if (raw && typeof raw === "object" && typeof raw.all === "number") return clamp(raw.all);
  } catch { /* absent or malformed ⇒ fall through to env */ }
  return clamp(Number((env.LIFEOS_AUTOCONTINUE_ALL ?? "0").toString().trim()));
}

// ── Grants (the "auto-continue for 2 hours" licence) ─────────────────────────

/**
 * A GRANT is a time-boxed licence to run longer than the standing budget, scoped to
 * ONE session. It exists because the standing brakes are sized for a supervised desk
 * session — a cap of 3 and a 45-minute ceiling are right when someone is nearby, and
 * simply wrong when the instruction was "auto-continue for the next two hours".
 * Written by the ContinuationArm hook when the principal says the directive out loud
 * (lib/continuation-directive.ts owns that grammar).
 *
 * THE SAFETY PROPERTY IS EXPIRY, NOT SIZE. A grant carries an absolute `untilMs`, so
 * the failure mode of every bug here is that autonomy STOPS. Nothing renews a grant,
 * nothing extends one implicitly, and an expired grant is indistinguishable from no
 * grant. Deliberately NOT relaxed by a grant: a question to the principal, a tool
 * error, and a no-tool turn all still hand back immediately — a grant buys unattended
 * TIME, never unattended JUDGEMENT.
 */
export interface Grant {
  session: string;
  cap: number;
  untilMs: number;
}

/** A grant may raise the cap this far and no further. The CLOCK is the real bound. */
export const GRANT_HARD_CAP = 50;
/** No single grant may run longer than this, however it was requested. */
export const GRANT_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * The grant in force for `session`, or null. Fail-CLOSED on anything unexpected: a
 * malformed grant, a grant for another session, or one whose window has passed all
 * read as "no grant", which falls back to the standing budget, never to more autonomy.
 */
export function activeGrant(raw: string, session: string, now = Date.now()): Grant | null {
  try {
    const g = JSON.parse(raw)?.grant;
    if (!g || typeof g !== "object") return null;
    if (typeof g.session !== "string" || g.session !== session) return null;   // never cross sessions
    if (typeof g.untilMs !== "number" || !(now < g.untilMs)) return null;      // expired, or no clock
    const cap = Math.min(Math.floor(Number(g.cap)), GRANT_HARD_CAP);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return { session, cap, untilMs: g.untilMs };
  } catch { return null; }
}

/**
 * The budget actually in force this turn: the standing cap and ceiling, unless a live
 * grant for THIS session raises them. A grant only ever RAISES — a larger hand-armed
 * standing cap is never demoted by a smaller grant.
 */
export function resolveBudget(
  session: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): { cap: number; maxMs: number; grant: Grant | null } {
  const standing = {
    cap: allSessionCap(readFile, env),
    maxMs: Number(env.LIFEOS_AUTOCONTINUE_MAX_MS) || DEFAULT_MAX_MS,
    grant: null as Grant | null,
  };
  let raw = "";
  try { raw = readFile(CAP_PATH); } catch { return standing; }
  const grant = activeGrant(raw, session, now);
  if (!grant) return standing;
  return { cap: Math.max(standing.cap, grant.cap), maxMs: Math.max(standing.maxMs, grant.untilMs - now), grant };
}

/** First unchecked criterion, so the continuation turn gets a target and not a vibe. */
export function nextOpenCriterion(isaContent: string): string | null {
  const open = parseCriteriaList(isaContent).find((c) => c.status !== "completed");
  return open ? `${open.id ? open.id + ": " : ""}${open.description}`.slice(0, 180) : null;
}

// ── State (per-run counter; the loop breaker) ────────────────────────────────

interface RunState { count: number; firstAt: number; humanTurn: string }
type StateFile = Record<string, RunState>;

/** Lenient read for ADVISORY checks only (early exits, shadow messages): absent
 * and unreadable both read as empty. Never feed this to the authoritative commit. */
function readState(): StateFile {
  return readStateStrict() ?? {};
}

/** Strict read for the COMMIT path: an ABSENT file is genuinely fresh ({}), but a
 * present-yet-unreadable one is null — corruption must refuse the continue, not
 * hand the run a brand-new budget. */
function readStateStrict(): StateFile | null {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as StateFile;
  } catch { return null; }
}

const LOCK_PATH = STATE_PATH + ".lock";
/** A lock older than this is a crashed holder, not a live one. Generous: a healthy
 * commit holds the lock for milliseconds. */
const LOCK_STALE_MS = 30_000;
/** This process's lock token: RELEASE is owner-verified against it, so no process
 * ever releases a lock another live process holds. Stale-BREAK is age-verified
 * instead — the whole premise of a stale lock is that its owner is dead. */
const LOCK_TOKEN = `${process.pid}.${Math.random().toString(36).slice(2)}`;

/** Exclusive-create lockfile serializing the counter commit. `wx` is the atomicity
 * primitive (O_EXCL); a held lock means another Stop evaluation is mid-commit, and
 * the caller REFUSES to continue rather than racing it — the failure direction of
 * contention is always a hand-back, never a double continue. A stale lock (crashed
 * holder) is broken once, then re-contended through `wx`; the unavoidable stat→unlink
 * window can at worst delete a lock acquired in that microsecond gap, which costs
 * one racing commit that the cap still bounds — never an unbounded run. */
export function acquireStateLock(now = Date.now()): boolean {
  try { mkdirSync(dirname(LOCK_PATH), { recursive: true }); } catch { return false; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, LOCK_TOKEN, { flag: "wx" });
      return true;
    } catch {
      // Held. Break it only if the holder is provably stale (crashed mid-commit).
      try {
        const age = now - statSync(LOCK_PATH).mtimeMs;
        if (age < LOCK_STALE_MS) return false;
        unlinkSync(LOCK_PATH);
      } catch { return false; }
    }
  }
  return false;
}

/** Owner-verified: only the process whose token is in the file may release it. */
export function releaseStateLock(): void {
  try {
    if (readFileSync(LOCK_PATH, "utf-8") !== LOCK_TOKEN) return;
    unlinkSync(LOCK_PATH);
  } catch { /* already gone */ }
}

/**
 * The ONE place a continue is spent, and the cap is enforced HERE, inside the lock —
 * a pre-lock read is only ever an advisory early-exit. Two Stop evaluations that both
 * read `count=0` outside any lock would otherwise both commit `count=1` sequentially
 * and both continue past a cap of 1. Under the lock: re-read, re-check freshness and
 * cap against the authoritative state, write, and READ BACK. Any failure — contended
 * lock, cap actually reached, unpersisted write — refuses the continue.
 * (Concurrent Stops for DIFFERENT sessions share this file too: the lock also stops
 * two read-modify-writes from silently dropping each other's counters.)
 */
function commitContinue(slug: string, humanTurn: string, cap: number): { ok: boolean; count: number; why?: string } {
  if (!acquireStateLock()) return { ok: false, count: -1, why: "state-lock-contended" };
  try {
    const all = readStateStrict();
    if (all === null) return { ok: false, count: -1, why: "state-unreadable" };
    const prior = all[slug];
    const fresh = !prior || prior.humanTurn !== humanTurn;
    const count = fresh ? 0 : prior.count;
    const firstAt = fresh ? Date.now() : prior.firstAt;
    if (count >= cap) return { ok: false, count, why: "cap-reached" };
    const next: RunState = { count: count + 1, firstAt, humanTurn };
    all[slug] = next;
    // Bound the file: keep the 50 most recently touched runs.
    const trimmed = Object.entries(all).sort((a, b) => b[1].firstAt - a[1].firstAt).slice(0, 50);
    writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(trimmed)));
    const back = readState()[slug];
    if (!back || back.count !== next.count || back.humanTurn !== next.humanTurn) {
      return { ok: false, count, why: "counter-not-persisted" };
    }
    return { ok: true, count: next.count };
  } catch { return { ok: false, count: -1, why: "counter-not-persisted" }; } finally { releaseStateLock(); }
}

/** Every verdict — continue or hand-back, armed or shadow — appended locally.
 * Schema: {ts, verdict, why, ...context}. This file is the feature's evidence. */
function obs(rec: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(OBS_PATH), { recursive: true });
    appendFileSync(OBS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch {}
}

/** Identity of the most recent real human turn — the counter's reset key.
 * Uses the `origin.kind === "human"` stamp Claude Code writes on typed input. */
export function lastHumanTurnId(transcriptPath: string): string {
  try {
    if (!existsSync(transcriptPath)) return "";
    const buf = readFileSync(transcriptPath);
    const tail = buf.length > 4_000_000 ? buf.subarray(buf.length - 4_000_000).toString("utf-8") : buf.toString("utf-8");
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (!l.includes('"kind":"human"')) continue;
      try {
        const o = JSON.parse(l);
        if (o?.origin?.kind === "human" && o?.uuid) return String(o.uuid);
      } catch { /* partial line */ }
    }
  } catch {}
  return "";
}

/** True when the turn called AskUserQuestion — parseTurnEvents does not model it.
 * Scans backward from the end; a hit before the last human-turn boundary means this
 * turn asked. If the scan window EXHAUSTS without finding the boundary (a turn with
 * megabytes of tool output), the answer is unknowable from the tail — report true,
 * because the conservative misread here is one hand-back, and the liberal one is
 * continuing past a question the principal was literally shown. */
export function askedViaTool(transcriptPath: string): boolean {
  try {
    if (!existsSync(transcriptPath)) return false;
    const buf = readFileSync(transcriptPath);
    const truncated = buf.length > 2_000_000;
    const tail = truncated ? buf.subarray(buf.length - 2_000_000).toString("utf-8") : buf.toString("utf-8");
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (l.includes('"origin"') && l.includes('"kind":"human"')) return false;  // hit the turn boundary first
      if (l.includes('"AskUserQuestion"')) return true;
    }
    return truncated;  // boundary never seen in a clipped window ⇒ unknowable ⇒ hand back
  } catch {}
  return false;
}

// ── No-ISA continuation ──────────────────────────────────────────────────────

/**
 * Continuation for a session with no run bound to it. Same deterministic gates as
 * the ISA path, same per-turn budget mechanics, but the "is the work finished?"
 * answer comes from a judge rather than an ISC count.
 *
 * Budget is keyed by SESSION here rather than by run slug, since there is no slug.
 * With the path unarmed (cap 0) this function returns before any model call —
 * a stock install pays nothing until it opts in.
 */
async function runJudgePath(
  input: HookInput,
  session: string,
  message: string,
  asked: { inProse: boolean; viaTool: boolean },
  cleanliness: { ok: boolean; why: string },
  turnEvents: TxEvent[],
): Promise<object | null> {
  const { cap, maxMs, grant } = resolveBudget(session);
  const base = { path: "no-isa", cap, ...(grant ? { grant_until: new Date(grant.untilMs).toISOString() } : {}) };
  if (cap === 0) { obs({ verdict: "hand-back", why: "not-armed", ...base }); return null; }
  if (asked.viaTool) { obs({ verdict: "hand-back", why: "asks-principal", ...base, ask: "tool" }); return null; }
  if (asked.inProse) { obs({ verdict: "hand-back", why: "asks-principal", ...base, ask: "prose" }); return null; }
  if (!cleanliness.ok) { obs({ verdict: "hand-back", why: cleanliness.why, ...base }); return null; }

  const key = `session:${session}`;
  const humanTurn = lastHumanTurnId(input.transcript_path);
  const prior = readState()[key];
  const fresh = !prior || prior.humanTurn !== humanTurn;
  const count = fresh ? 0 : prior.count;
  const firstAt = fresh ? Date.now() : prior.firstAt;

  if (count >= cap) { obs({ verdict: "hand-back", why: "cap-reached", ...base, count }); return null; }
  if (Date.now() - firstAt > maxMs) { obs({ verdict: "hand-back", why: "wallclock-ceiling", ...base, count }); return null; }
  // The grant's own deadline is absolute: a licence issued at 23:00 for 2h expires at
  // 01:00 even if this particular run only started at 00:55.
  if (grant && Date.now() >= grant.untilMs) { obs({ verdict: "hand-back", why: "grant-expired", ...base, count }); return null; }

  // Only now is a model worth spending: every deterministic gate has passed.
  const verdict = await askJudge(message, turnEvents.filter((e) => e.kind !== "user-text").map((e) => ({ name: e.tool, ok: !e.isError })));
  if (!verdict) { obs({ verdict: "hand-back", why: "judge-unavailable", ...base, count }); return null; }
  if (verdict.finished) { obs({ verdict: "hand-back", why: "judge-says-finished", ...base, count, judge: verdict.why }); return null; }

  const commit = commitContinue(key, humanTurn, cap);
  if (!commit.ok) { obs({ verdict: "hand-back", why: commit.why ?? "counter-not-persisted", ...base, count }); return null; }

  obs({ verdict: "continue", why: "judge-says-unfinished", ...base, count: commit.count, judge: verdict.why });
  const who = await principalName();
  const left = cap - commit.count;
  return {
    decision: "block",
    reason:
      `CONTINUE [ContinuationGate ${commit.count}/${cap}, no-ISA path]. Your reply asked ${who} nothing, this turn's ` +
      `tool evidence was clean, and a second opinion judged the work unfinished: "${verdict.why || "work still outstanding"}". ` +
      `So this is a turn boundary, not a decision point.\n\n` +
      `Carry on with what you were doing. Do NOT re-greet, re-summarise, or restate the plan. If you genuinely need ` +
      `${who} — a real choice, an irreversible or external action — or the work really is done, say so ` +
      `plainly and this gate hands back automatically. ` +
      `Budget: ${left} auto-continue${left === 1 ? "" : "s"} left before ${who} is asked.`
      + (grant
        ? `\n\nUNATTENDED RUN: ${who} said auto-continue until ${new Date(grant.untilMs).toISOString()}. ` +
          `They are away and will read the result later, so do not wait on them, and do not stop to ask ` +
          `something you can decide and note. Keep choices reversible and leave an auditable trail of decisions.`
        : ""),
  };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/** Returns a decision object to emit, or null. Pure of exit/stdout. */
export async function run(input: HookInput): Promise<object | null> {
  if (process.env.CONTINUATIONGATE_OFF === "1") return null;

  const message = input.last_assistant_message ?? "";
  const session = input.session_id ?? "";
  if (!message.trim() || !session) return null;

  // An active run, or nothing for the ISA path to continue toward.
  let active: ReturnType<typeof findActiveSessionByUUID> = null;
  try { active = findActiveSessionByUUID(session); } catch { return null; }

  // The deterministic predicates, computed once and shared by both paths so the
  // ISA path and the no-ISA path can never disagree about whether the principal
  // was asked something. Cheap: two regex passes plus one transcript scan.
  const asked = { inProse: asksPrincipal(message), viaTool: askedViaTool(input.transcript_path) };
  let turnEvents: TxEvent[] = [];
  try { turnEvents = parseTurnEvents(input.transcript_path); } catch { /* empty ⇒ not clean ⇒ hand back */ }
  const cleanliness = evidenceClean(turnEvents);

  // ── NO-ISA PATH ─────────────────────────────────────────────────────────────
  // Most sessions carry no ISA. Without a run there are no ISC criteria to count,
  // so the "is it finished?" question goes to a judge instead. Everything else is
  // unchanged, and only an explicit `finished: false` continues — a judge that
  // crashes, times out or waffles hands back.
  if (!active) return await runJudgePath(input, session, message, asked, cleanliness, turnEvents);
  if ((active.session.phase || "").toLowerCase() === "complete") {
    obs({ verdict: "hand-back", why: "run-complete", slug: active.slug }); return null;
  }

  // Articulated, still-open criteria. No criteria = fog = no autonomy.
  const isaPath = active.session.isa || findArtifactPath(active.slug);
  let isa = "";
  try { isa = isaPath && existsSync(isaPath) ? readFileSync(isaPath, "utf-8") : ""; } catch { /* fail toward hand-back below */ }
  if (!isa) { obs({ verdict: "hand-back", why: "no-isa", slug: active.slug }); return null; }
  const { checked, total } = countCriteria(isa);
  const open = total - checked;
  if (total === 0) { obs({ verdict: "hand-back", why: "no-criteria", slug: active.slug }); return null; }
  if (open <= 0) { obs({ verdict: "hand-back", why: "all-criteria-closed", slug: active.slug }); return null; }

  // Arming. Cap 0 keeps every check above running so shadow mode measures the
  // real decision, not a stub — and on this path the "verdict" is a checkbox
  // count, so shadow costs nothing. A live grant for this session raises the cap
  // here too: "auto-continue for 2 hours" should not stop applying just because
  // the run happens to have an ISA bound to it.
  const isaCap = resolveCap(parseFrontmatter(isa), process.env);
  const budget = resolveBudget(session);
  const cap = Math.max(isaCap, budget.grant ? budget.cap : 0);

  // A question — via tool or in prose — ends the streak, armed or not.
  if (asked.viaTool) { obs({ verdict: "hand-back", why: "asks-principal", slug: active.slug, cap, ask: "tool" }); return null; }
  if (asked.inProse) { obs({ verdict: "hand-back", why: "asks-principal", slug: active.slug, cap, ask: "prose" }); return null; }

  // Real, clean work this turn.
  if (!cleanliness.ok) { obs({ verdict: "hand-back", why: cleanliness.why, slug: active.slug, cap }); return null; }

  // Budget: consecutive continues since the principal last spoke, and wall clock.
  const humanTurn = lastHumanTurnId(input.transcript_path);
  const prior = readState()[active.slug];
  const fresh = !prior || prior.humanTurn !== humanTurn;
  const count = fresh ? 0 : prior.count;
  const firstAt = fresh ? Date.now() : prior.firstAt;
  const maxMs = budget.maxMs;

  const nextCriterion = nextOpenCriterion(isa);
  const base = { slug: active.slug, cap, count, open, total, criterion: nextCriterion };
  if (budget.grant && Date.now() >= budget.grant.untilMs) {
    obs({ verdict: "hand-back", why: "grant-expired", ...base }); return null;
  }

  // SHADOW (cap 0) and CAP-REACHED are the two verdicts worth the principal's eyes,
  // so they surface as a display-only `systemMessage` rather than dying in the log.
  // Every other verdict stays log-only — a reminder the reader can't act on is noise.
  if (count >= cap) {
    const why = cap === 0 ? "shadow-would-continue" : "cap-reached";
    obs({ verdict: "hand-back", why, ...base });
    return cap === 0
      ? { systemMessage: `⏭️ ContinuationGate [shadow]: would have continued — ${open}/${total} ISCs open on '${active.slug}'. Arm with \`autocontinue: 3\` in the ISA.` }
      : { systemMessage: `⏭️ ContinuationGate: cap reached (${cap}/${cap}) on '${active.slug}', ${open}/${total} ISCs still open. Over to you.` };
  }
  if (Date.now() - firstAt > maxMs) { obs({ verdict: "hand-back", why: "wallclock-ceiling", ...base }); return null; }

  // The counter is the loop breaker — the cap is re-checked and spent under the
  // state lock; no serialized, persisted counter means no continuation.
  const commit = commitContinue(active.slug, humanTurn, cap);
  if (!commit.ok) { obs({ verdict: "hand-back", why: commit.why ?? "counter-not-persisted", ...base }); return null; }

  obs({ verdict: "continue", why: "open-criteria-remain", ...base, count: commit.count });
  const who = await principalName();
  const left = cap - commit.count;
  return {
    decision: "block",
    reason:
      `CONTINUE [ContinuationGate ${commit.count}/${cap}]. Run '${active.slug}' has ${open} of ${total} ISC criteria still open, ` +
      `this turn's tool evidence was clean, and your reply asked ${who} nothing — so this is a turn boundary, not a decision point. ` +
      `Keep going instead of handing back.\n\n` +
      `Next open criterion: ${nextCriterion ?? "(see the ISA's ISC Criteria section)"}\n` +
      `ISA: ${isaPath}\n\n` +
      `Advance that criterion now. Do NOT re-greet, re-summarise what you just did, or restate the plan — continue the work and ` +
      `close the criterion on real evidence. If you genuinely need ${who} (a real choice, an irreversible or external action, ` +
      `or the work is actually done), say so plainly in your next reply and this gate will hand back automatically. ` +
      `Budget: ${left} auto-continue${left === 1 ? "" : "s"} left before ${who} is asked.`,
  };
}

if (import.meta.main) {
  (async () => {
    const { readHookInput } = await import("./lib/hook-io");
    const input = await readHookInput();
    if (input) {
      const d = await run(input);
      if (d) console.log(JSON.stringify(d));
    }
    process.exit(0);
  })().catch((err) => { console.error("[ContinuationGate] fatal:", err); process.exit(0); });
}

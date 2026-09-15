/**
 * continuation-directive.ts — the user-facing arming grammar for ContinuationGate.
 *
 * "auto-continue for 2 hours" said in a prompt grants THAT session a time-boxed
 * licence to continue past turn boundaries. This module is the pure parser; the
 * ContinuationArm hook owns the file write. Deterministic on purpose — no model
 * decides whether the user meant it, the words do.
 *
 * THE GRAMMAR IS STRICT BY DESIGN: the literal keyword (`auto-continue`, with the
 * hyphen/space/joined variants) must appear WITH an explicit cue — a duration
 * ("for 2h"), "until done/finished/complete", "on", or an off-word. A mere mention
 * ("how does auto-continue work?", "review the auto-continue code") arms nothing:
 * an accidental grant spends unattended turns, a missed one costs a rephrase.
 *
 * Deliberation defuses: "should we auto-continue for 2 hours?" is a discussion,
 * not a directive. But a polite REQUEST keeps working — voice users phrase
 * commands as questions ("could you auto-continue for 2 hours?"), so a question
 * mark only defuses forms that lack an explicit duration.
 */

/** Bare "auto-continue on" / "until done" get this window. */
export const DIRECTIVE_DEFAULT_MS = 2 * 60 * 60 * 1000;
/** The overnight family ("overnight", "all night", "until morning", "while I
 * sleep") gets a night's worth. Fixed rather than clock-derived on purpose:
 * "until 08:00 local" would make the grant's size depend on when it was said,
 * and a deterministic grammar should not have a clock inside it. */
export const DIRECTIVE_OVERNIGHT_MS = 8 * 60 * 60 * 1000;
/** No single utterance may license more than this, however phrased. */
export const DIRECTIVE_MAX_MS = 12 * 60 * 60 * 1000;
/** Continues per grant window. Higher than the standing HARD_CAP of 8 because an
 * unattended window has no human turns to reset the counter; still finite. */
export const DIRECTIVE_DEFAULT_CAP = 25;
export const DIRECTIVE_MAX_CAP = 50;

export type Directive =
  | { action: "arm"; untilMs: number; cap: number }
  | { action: "off" };

const KEYWORD = /\bauto[- ]?continue\b/i;
const OFF = /\b(off|stop|cancel|disable|end)\b/i;
const UNTIL_DONE = /\buntil\b[^.?!]{0,40}\b(done|finished|complete[d]?)\b/i;
const ON = /\bauto[- ]?continue\b[,:]?\s+on\b/i;
const DURATION = /\bfor\s+(?:the\s+next\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i;
/** Deliberative frames: talking ABOUT arming, not asking for it. */
const DELIBERATION = /\b(should (we|i)|would it|is it worth|worth it to|do we want|what if (we|i)|whether to)\b/i;
/** Overnight cue AFTER the keyword, same clause (no sentence punctuation between). */
const OVERNIGHT = /\bauto[- ]?continue\b[^.?!\n]{0,60}\b(overnight|all night|for the night|(un)?til+ (the )?morning|while i sleep|while i'?m (asleep|away|out|gone)|back in the morning)\b/i;
/** Analytic chatter about past or observed runs — reading, not directing. */
const ANALYTIC = /\b(review|debug|check|inspect|read|explain|why|log|logs|failed|failure|ran|stopped|yesterday|last night)\b/i;

export function parseAutoContinueDirective(prompt: string, now = Date.now()): Directive | null {
  const p = String(prompt ?? "").trim();
  if (!p || !KEYWORD.test(p)) return null;
  if (DELIBERATION.test(p)) return null;

  // OFF is checked before arming cues so "stop auto-continue" can never re-arm.
  // Analytic chatter defuses OFF too: "why did auto-continue stop overnight" is a
  // question about a run, not an order — and a false null here only leaves the
  // current state standing, which a plain "auto-continue off" fixes in one line.
  if (OFF.test(p)) return ANALYTIC.test(p) ? null : { action: "off" };

  const clampCap = (n: number) =>
    Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), DIRECTIVE_MAX_CAP) : DIRECTIVE_DEFAULT_CAP;
  const capMatch = /\b(?:cap|up to)\s+(\d+)\b/i.exec(p);
  const cap = clampCap(capMatch ? Number(capMatch[1]) : NaN);

  const dur = DURATION.exec(p);
  if (dur) {
    const n = Number(dur[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = dur[2]!.toLowerCase().startsWith("m") ? n * 60_000 : n * 3_600_000;
    return { action: "arm", untilMs: now + Math.min(ms, DIRECTIVE_MAX_MS), cap };
  }

  // Overnight family — duration-grade intent (survives a question mark, like an
  // explicit duration). Two guards keep mention from becoming consent: the cue must
  // FOLLOW the keyword inside one clause (so "the overnight auto-continue logs"
  // stays inert), and analytic chatter about runs/logs/failures defuses outright.
  if (OVERNIGHT.test(p) && !ANALYTIC.test(p)) {
    return { action: "arm", untilMs: now + DIRECTIVE_OVERNIGHT_MS, cap };
  }

  // The cue-less forms ("until done", "on") are weaker evidence of intent, so a
  // question mark defuses them where an explicit duration would have survived it.
  if (/\?/.test(p)) return null;
  if (UNTIL_DONE.test(p) || ON.test(p)) {
    return { action: "arm", untilMs: now + DIRECTIVE_DEFAULT_MS, cap };
  }
  return null;
}

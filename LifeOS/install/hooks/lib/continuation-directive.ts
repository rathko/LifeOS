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
/**
 * OFF must be ANCHORED TO THE KEYWORD. It used to match a stop-word anywhere in the
 * prompt and was checked before DURATION, so "auto-continue for 2 hours and stop
 * when the tests pass" DISARMED — as did "...work to the end of the list", on the
 * word "end" (reported by Martins Zaumanis, 2026-10-01, who reproduced both).
 * An accidental disarm is only lost throughput, but it is indistinguishable from
 * the feature being broken, which is worse for adoption than a missed grant.
 */
const OFF = /\bauto[- ]?continue\b[\s,:]*(off|stop|cancel|disable)\b|\b(stop|cancel|disable|end|turn\s+off)\s+(the\s+)?auto[- ]?continue\b/i;
/** A negated stop is not a stop ("don't stop auto-continue"). */
const NEGATED_OFF = /\b(do\s*n[o']t|don'?t|never|do not)\b[^.?!]{0,20}\b(stop|cancel|disable|turn\s+off|end)\b/i;
const UNTIL_DONE = /\buntil\b[^.?!]{0,40}\b(done|finished|complete[d]?)\b/i;
const ON = /\bauto[- ]?continue\b[,:]?\s+on\b/i;
const DURATION = /\bfor\s+(?:the\s+next\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i;
/** Dictation says "two hours", not "2 hours" — and the principal of this feature is
 * a voice user, so digits-only was the wrong contract (same reviewer). */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, ninety: 90, "a couple of": 2, "a few": 3, "an": 1, a: 1,
};
const WORD_DURATION = new RegExp(
  `\\bfor\\s+(?:the\\s+next\\s+)?(half\\s+an?|${Object.keys(WORD_NUMBERS).map((k) => k.replace(/ /g, "\\s+")).join("|")})\\s+(h|hr|hrs|hours?|m|min|mins|minutes?)\\b`,
  "i",
);
/** Deliberative frames: talking ABOUT arming, not asking for it. */
const DELIBERATION = /\b(should (we|i)|would it|is it worth|worth it to|do we want|what if (we|i)|whether to)\b/i;
/** Overnight cue AFTER the keyword, same clause (no sentence punctuation between). */
const OVERNIGHT = /\bauto[- ]?continue\b[^.?!\n]{0,60}\b(overnight|all night|for the night|(un)?til+ (the )?morning|while i sleep|while i'?m (asleep|away|out|gone)|back in the morning)\b/i;
/**
 * PAST-RUN chatter — reading about a run that already happened, not directing one.
 *
 * This used to be a broad ANALYTIC list that included ordinary task verbs (review,
 * debug, check, inspect, read), which meant "auto-continue overnight and review the
 * open PRs" armed nothing: a plausible instruction, silently ignored (same reviewer).
 * Task verbs are what an unattended run is FOR. Only the past-tense and log-shaped
 * words defuse now.
 */
const PAST_RUN = /\b(logs?|failed|failure|crashed|ran|stopped|yesterday|last night|earlier|why did|what happened)\b/i;

/**
 * A bare stop interjection ("stop", "halt", "enough"). It carries no keyword, so the
 * parser cannot treat it as a directive on its own — but a LIVE grant means the
 * principal is being obeyed unattended, and in that state the only safe reading of
 * "stop" is stop. The arm hook applies this when a grant exists; see its call site.
 * Deliberately narrow: a stop-word inside a real instruction ("stop the deploy and
 * fix the test") is work, not a revocation.
 */
export function isBareStop(prompt: string): boolean {
  const p = String(prompt ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!p || p.split(/\s+/).length > 3) return false;
  if (/\bnot?\b/.test(p)) return false;                       // "do not stop"
  return /^(stop|halt|hold|pause|abort|enough|that'?s enough|stop please|please stop|stop now)$/.test(p);
}

export function parseAutoContinueDirective(prompt: string, now = Date.now()): Directive | null {
  const p = String(prompt ?? "").trim();
  if (!p || !KEYWORD.test(p)) return null;
  if (DELIBERATION.test(p)) return null;

  // OFF is checked before arming cues so "stop auto-continue" can never re-arm. It is
  // anchored to the keyword (see OFF above), and two things defuse it: a negation
  // ("don't stop auto-continue") and past-run chatter ("why did auto-continue stop
  // overnight"). A false null here only leaves the current state standing, which a
  // plain "auto-continue off" fixes in one line.
  if (OFF.test(p)) return (PAST_RUN.test(p) || NEGATED_OFF.test(p)) ? null : { action: "off" };

  const clampCap = (n: number) =>
    Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), DIRECTIVE_MAX_CAP) : DIRECTIVE_DEFAULT_CAP;
  const capMatch = /\b(?:cap|up to)\s+(\d+)\b/i.exec(p);
  const cap = clampCap(capMatch ? Number(capMatch[1]) : NaN);

  const arm = (ms: number): Directive => ({ action: "arm", untilMs: now + Math.min(ms, DIRECTIVE_MAX_MS), cap });
  const unitMs = (unit: string, n: number) => (unit.toLowerCase().startsWith("m") ? n * 60_000 : n * 3_600_000);

  const dur = DURATION.exec(p);
  if (dur) {
    const n = Number(dur[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return arm(unitMs(dur[2]!, n));
  }

  // Spelled-out durations: same intent, different transcription.
  const wdur = WORD_DURATION.exec(p);
  if (wdur) {
    const word = wdur[1]!.toLowerCase().replace(/\s+/g, " ");
    const unit = wdur[2]!;
    if (/^half\s+an?$/.test(word)) return arm(unitMs(unit, 1) / 2);
    const n = WORD_NUMBERS[word];
    if (n) return arm(unitMs(unit, n));
  }

  // Overnight family — duration-grade intent (survives a question mark, like an
  // explicit duration). Two guards keep mention from becoming consent: the cue must
  // FOLLOW the keyword inside one clause (so "the overnight auto-continue logs"
  // stays inert), and PAST-RUN chatter defuses outright. Ordinary task verbs no
  // longer defuse — an overnight run exists precisely to do tasks.
  if (OVERNIGHT.test(p) && !PAST_RUN.test(p)) {
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

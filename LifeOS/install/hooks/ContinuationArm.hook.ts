#!/usr/bin/env bun
/**
 * ContinuationArm.hook.ts — the spoken front door for ContinuationGate.
 *
 * "auto-continue for 2 hours" said in a prompt grants THIS session a time-boxed
 * licence to continue past turn boundaries; "auto-continue off" revokes it. The
 * grammar is deterministic and strict (lib/continuation-directive.ts): the literal
 * keyword plus an explicit cue, so a question ABOUT auto-continue never arms it,
 * and no model sits between the user's words and the arming decision.
 *
 * Division of labour, on purpose:
 *   - THIS hook (UserPromptSubmit) — arming by utterance, session-scoped, expiring.
 *   - ContinuationDoctor (CLI)     — standing config, wiring checks, verdict history.
 *   - ContinuationGate (Stop)      — the enforcement; reads the grant fail-closed.
 *
 * The write is a MERGE into the cap file (the standing `isa`/`all` keys survive),
 * 0600 (arming is a privilege decision), read back before confirming. Every failure
 * is silent-open: this hook must never be why a prompt breaks, and an unwritten
 * grant simply means the gate keeps its standing budget.
 *
 * TRIGGER: UserPromptSubmit (registered in hooks.json)
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAutoContinueDirective, type Directive } from "./lib/continuation-directive";

const LIFEOS = process.env.LIFEOS_DIR || join(process.env.HOME!, ".claude", "LIFEOS");
const CAP_PATH = join(LIFEOS, "MEMORY", "STATE", "continuation-cap.json");

/** Apply a parsed directive to the cap file. Exported for tests; the shim below
 * owns stdin/stdout. Returns the user-facing confirmation, or null when nothing
 * changed (including every failure — fail silent-open, never break a prompt). */
export function applyDirective(d: Directive, session: string, capPath: string = CAP_PATH): string | null {
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(capPath, "utf-8")) ?? {}; } catch { /* start fresh */ }

    if (d.action === "off") {
      if (!existing.grant) return "⏭️ auto-continue: no licence was active.";
      delete existing.grant;
    } else {
      existing.grant = { session, cap: d.cap, untilMs: d.untilMs };
    }

    mkdirSync(dirname(capPath), { recursive: true });
    writeFileSync(capPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    chmodSync(capPath, 0o600);  // fs mode only applies on create; enforce on the existing file too

    // Read back: an unpersisted grant must not be confirmed as live.
    const back = JSON.parse(readFileSync(capPath, "utf-8"));
    if (d.action === "off") {
      return back?.grant ? null : "⏭️ auto-continue: licence revoked. Standing budget applies from the next turn.";
    }
    const g = back?.grant;
    if (!g || g.session !== session || g.untilMs !== d.untilMs) return null;
    const until = new Date(d.untilMs);
    const hh = String(until.getHours()).padStart(2, "0");
    const mm = String(until.getMinutes()).padStart(2, "0");
    return `⏭️ auto-continue armed for THIS session until ${hh}:${mm} (up to ${d.cap} continues). ` +
      `Questions to you, tool errors, and no-work turns still hand back. Say "auto-continue off" to revoke.`;
  } catch { return null; }
}

async function readStdin(): Promise<string> {
  const timeout = new Promise<string>((r) => setTimeout(() => r(""), 2000));
  const read = (async () => {
    let s = "";
    for await (const chunk of Bun.stdin.stream()) s += new TextDecoder().decode(chunk);
    return s;
  })();
  return Promise.race([read, timeout]);
}

if (import.meta.main) {
  (async () => {
    const raw = await readStdin();
    if (!raw.trim()) process.exit(0);
    let input: { session_id?: string; prompt?: string };
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const session = input.session_id ?? "";
    const prompt = input.prompt ?? "";
    if (!session || !prompt) process.exit(0);

    const d = parseAutoContinueDirective(prompt);
    if (!d) process.exit(0);
    const confirmation = applyDirective(d, session);
    if (confirmation) {
      console.log(JSON.stringify({
        systemMessage: confirmation,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: d.action === "arm"
            ? `The principal armed auto-continue for this session (until ${new Date(d.untilMs).toISOString()}). ` +
              `The Stop gate will hand you continuation turns while work is demonstrably unfinished; you do not ` +
              `need to ask permission to keep working, and you should not stop to ask anything you can decide ` +
              `reversibly and note.`
            : "The principal revoked auto-continue for this session; the standing budget applies again.",
        },
      }));
    }
    process.exit(0);
  })().catch(() => process.exit(0));
}

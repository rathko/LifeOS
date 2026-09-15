#!/usr/bin/env bun
/**
 * @version 1.2.0
 * StopGates.hook.ts — the ONE Stop-event gate hook.
 *
 * Consolidation (2026-07-11, hooks BPE pass): merges the three per-turn gate
 * spawns into one process, reading stdin ONCE. Each gate file remains the
 * owner of its logic (and stays runnable standalone via its own shim); this
 * hook imports their exported run() and evaluates in the old registration
 * order:
 *
 *   1. OutputFormatGate.run()  — banner/aispeak/heartbeat (telemetry-only today)
 *   2. VerificationGate.run()  — claim-vs-evidence teeth (T1-T3 block)
 *   3. ISACloseGate.run()      — ISA-freshness teeth at major-work completion
 *   4. ISAFoldGate.run()       — D-50 teeth: prod mutated + ISA untouched blocks
 *   5. WritingGate.run()       — authored-prose audit teeth (strong signals block)
 *
 * Decision semantics live in lib/gate-chain.ts (testable on its own): the FIRST
 * gate returning a `decision:"block"` wins and short-circuits, and a block from
 * ANY gate outranks a non-block object from an earlier one. The old inline
 * reducer kept the first object outright, so a passive `systemMessage` from an
 * early gate silently swallowed a block from any gate below it — harmless only
 * while every gate short-circuited on `stop_hook_active` recovery, and fatal
 * for ContinuationGate, which deliberately does not.
 *
 * Failure mode: each gate's run() fails open internally; the chain catches
 * anything residual per-gate so one gate's crash never silences the others.
 * The gate must never be why a Stop breaks — always exit 0.
 */

import { readHookInput } from "./lib/hook-io";
import { decide, type GateFn } from "./lib/gate-chain";
import { run as formatGate } from "./FormatGate.hook";
import { run as verificationGate } from "./VerificationGate.hook";
import { run as isaCloseGate } from "./ISACloseGate.hook";
import { run as isaFoldGate } from "./ISAFoldGate.hook";
import { run as isaStructureGate } from "./ISAGate.hook";
import { run as writingGate } from "./WritingGate.hook";
import { run as deployRegistrationGate } from "./DeployRegistrationGate.hook";
import { run as continuationGate } from "./ContinuationGate.hook";

// OutputFormatGate (mode-banner telemetry) removed 2026-07-11; FormatGate is
// its unified-format successor WITH TEETH (2026-07-11): deterministic
// structural checks on the one LifeOS format — banner first, 🗣️ closer last,
// 🧠 line when a delta arrived, ≤2 prose em-dashes. Voice/vocabulary drift
// stays DriftReminder's job; this gate is structure only. First in order so a
// format fix is the recovery turn's single clear instruction.
const GATES: Array<[string, GateFn]> = [
  ["FormatGate", formatGate],
  ["VerificationGate", verificationGate],
  // ISACloseGate: a completion claim on an active run with a provably stale ISA blocks
  // once. Order matters — evidence gaps (VerificationGate) outrank the bookkeeping fold-in.
  ["ISACloseGate", isaCloseGate],
  // ISAFoldGate (2026-07-29, D-50 enforcement): prod mutated this turn + active run +
  // ISA untouched + reply silent on ISA state → block. Phrase-independent — the gap
  // ISACloseGate's COMPLETION_RE cannot see ("rigged and armed" isn't "done").
  ["ISAFoldGate", isaFoldGate],
  // ISAGate (2026-07-24, granularity/testability upgrade F3): blocks a close
  // (phase: complete written this turn) on un-gameable STRUCTURAL violations —
  // non-M/N progress, fog-at-complete, missing anchors_to. Scoped to ISAs
  // touched this turn (legacy files never retroactively gated). Complements
  // ISACloseGate (stale-ISA) with a different, structural tooth.
  ["ISAGate", isaStructureGate],
  // DeployRegistrationGate (OPERATIONAL_RULES § Bunker registration): a custom-domain
  // wrangler deploy this session must be registered in PROJECTS.md + the ARBOL
  // curated inventory before the turn ends. Fires once per domain per session.
  ["DeployRegistrationGate", deployRegistrationGate],
  ["WritingGate", writingGate],
  // ContinuationGate: MUST STAY LAST — every other gate is a reason to STOP; this
  // is the only reason to CONTINUE, so any stop outranks it. Registering it
  // anywhere else is a real bug, not a style choice. Ships in shadow mode (cap 0);
  // arm with `bun LIFEOS/TOOLS/ContinuationDoctor.ts --arm N`.
  ["ContinuationGate", continuationGate],
];

(async () => {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const emitted = await decide(GATES, input);
  if (emitted) console.log(JSON.stringify(emitted));
  process.exit(0);
})().catch((err) => {
  console.error("[StopGates] fatal:", err);
  process.exit(0);
});

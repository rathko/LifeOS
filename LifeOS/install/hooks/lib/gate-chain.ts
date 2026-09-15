/**
 * gate-chain.ts — arbitration for the Stop-gate chain.
 *
 * Extracted from StopGates.hook.ts so the arbitration rule is testable on its
 * own: StopGates itself imports every gate, and that graph reaches `yaml` via
 * hook-io → TranscriptParser → identity, which resolves under `bun run` but not
 * under `bun test`. This module imports nothing.
 */

export type GateFn = (input: any) => Promise<object | null>;

/**
 * Reduce the gate chain to at most one emitted decision.
 *
 * A `decision:"block"` from ANY gate outranks a non-block object returned by an
 * earlier one, and ends evaluation. The old inline reducer (`if (d && !emitted)`)
 * let the FIRST returned object win outright, so a passive `systemMessage` from
 * an early gate silently swallowed a block from any gate below it — harmless only
 * while every gate short-circuited on `stop_hook_active` recovery, and fatal for
 * ContinuationGate, which deliberately does not (a one-hop continuation would be
 * pointless; its per-run counter is the loop breaker instead).
 *
 * A gate that throws never silences the gates after it.
 */
export async function decide(
  gates: Array<[string, GateFn]>,
  input: any,
): Promise<object | null> {
  let emitted: object | null = null;
  for (const [name, gate] of gates) {
    try {
      const d = await gate(input);
      if (!d) continue;
      if ((d as { decision?: string }).decision === "block") return d;
      if (!emitted) emitted = d;   // first non-block object stands, unless a block arrives
    } catch (err) {
      console.error(`[StopGates] ${name} error:`, err);
    }
  }
  return emitted;
}

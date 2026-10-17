# CitedReport Workflow

A Perplexity-style deep research report on any topic, with its citations checked. A grounded overview search informs a section plan; each section is researched by one Google-Search-grounded Gemini pass (in parallel); every grounded claim carries an inline `[n]` citation into one deduplicated, tier-labelled reference list; each cited claim is then checked against excerpts of the pages it cites, and unsupported or partial claims are flagged in the text. An executive summary and cross-section notes (overlaps, contradictions) open and close the report. Output is a self-contained HTML page (shareable as one file, works offline), a markdown twin, and `verification.md` (plus `verification-perplexity.md` with `--cross-check`).

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CitedReport workflow in the Research skill to build a cited report"}' \
  > /dev/null 2>&1 &
```

## Done looks like

- `report.html` + `report.md` exist, every section present, references resolved to real URLs (not `vertexaisearch` redirects).
- The principal is told: where the report is, source count, the **citation-check line** (supported / partial / unsupported share), the cost line, and any failed calls.
- Every claim marked ⚠ (unsupported) that the summary or a decision rests on has been named to the principal. ⚠ means the cited pages did not say it; the claim may still be true, but it is not evidenced by its citation.
- With `--cross-check`: the Perplexity edition, its own citation-check line, and `comparison.md` exist, and **you have read both editions** and reported material factual disagreements with your judgement of which side is better evidenced. Prefer the side whose claim passed the citation check.

## Tool contract

```bash
# Optional: review the plan before paying for the section passes (2 calls: overview + plan)
bun ~/.claude/skills/Research/Tools/CitedReport.ts "<topic>" --sections 10 --plan-only --out <dir>

# Full run (re-uses <dir>/plan.json if present)
bun ~/.claude/skills/Research/Tools/CitedReport.ts "<topic>" --out <dir> [--follow-up] [--cross-check]

# Bring your own plan: JSON array of {"title","query"}
bun ~/.claude/skills/Research/Tools/CitedReport.ts "<topic>" --plan plan.json --out <dir>
```

Defaults: 10 sections, 4 calls in parallel, overview + citation check + summary on, follow-ups off, search budget 120. Output under `~/.claude/MEMORY/RESEARCH/cited-reports/<slug>-<hash>/` (stable per topic; the tool prints the folder and refuses an `--out` that belongs to another topic). Gemini model defaults to `CROSS_VENDOR.geminiResearcher` in `models.ts`; override with `--gemini-model`. Requires `GOOGLE_API_KEY` (and `PERPLEXITY_API_KEY` for `--cross-check`) as read by `LIFEOS/TOOLS/GeminiSearch.ts` / `PerplexitySearch.ts`. Exit codes: 0 ok, 1 error or failed calls (including grounding redirects not yet resolved), 2 another run holds the folder, 130/143 interrupted (SIGINT/SIGTERM).

Source tiers: a small built-in list (government, academic and standards bodies as primary; content farms as low) plus `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Research/SourceTiers.json` if present, or `--tiers <file>`: `{"primary": [...], "low": [...], "deny": [...]}`. Entries: `.gov` (suffix), `pinterest.` (label anywhere), `quora.com` (domain and subdomains). Denied sources are removed (a claim left with no source is marked †); low-tier sources are dropped from a claim that has a better source and labelled in References otherwise.

## Call budget

For N sections: 1 overview + 1 plan + N sections + ceil(claims/25) judge calls per section (usually 1–2) + 1 summary. `--follow-up` adds up to 2 per section; each follow-up reserves 6 searches up front and is skipped if that would pass `--max-searches` (only newly billed searches count; cached ones are free and reported separately). `--cross-check` adds N Perplexity calls plus their judge calls. A 10-section run with defaults is roughly 25–35 Gemini calls (about 45 with `--follow-up`); check any local daily cap first.

## Constraints

- **Launch once, from one command.** Run it in the background and read its output; never chain a "test" invocation in front of it. A concurrent second launch against the same `--out` exits 2 before spending anything.
- **Re-run, don't restart.** Every paid response is cached only after it validates, keyed by the exact command (model, prompt, flags), so re-running requests only failed or changed calls. Editing `plan.json` (changing, inserting or reordering sections) re-requests only sections whose query is new; changing the model re-requests everything. Ctrl-C stops before the next paid call. Never delete `raw/` to "retry".
- **Section count is coverage, not quality.** Each section yields roughly 8–15 sources. For 100–200 references use 10–14 sections; past that sections mostly overlap.

## Gotchas

- **Grounding returns redirect URLs.** `groundingChunks` point at `vertexaisearch.cloud.google.com/grounding-api-redirect/...`; the tool resolves them with a HEAD request and keeps the resolutions in `raw/redirects.json`, because the redirects may expire.
- **`groundingSupports` indices are UTF-8 byte offsets.** The tool converts and verifies them against the segment text, falling back to text search.
- **The citation check is excerpt-based.** It compares each claim to the best-matching passages of the cited pages, not the whole page, and judges with a cheap model. A claim is judged only if every page it cites yields a matching passage. Pages that block bots, need JavaScript, or are PDFs, claims too short to judge, and claims whose judge call failed all count as "not checkable", not as unsupported. Treat ⚠ as "go look", not as "false". The summary is written from checked sections but is not itself checked, and says so.
- **Cited pages are fetched from the open web.** Only http(s) to hostnames whose every resolved address is public is fetched, re-checked on every redirect hop; loopback, private, link-local and CGNAT (tailnet) ranges are refused, and bodies are capped at 3 MB. Do not loosen this to "fix" an unreachable source. Accepted residual risk: the address check and the fetch resolve DNS separately, so a rebinding domain could slip one GET to an internal address; its text would only reach the judge prompt as an excerpt. Run on a host where that matters behind an egress proxy.
- **Model output and cited pages are untrusted.** Raw HTML in answers renders as text, the page ships a strict Content-Security-Policy that also blocks remote images, and the judge and summary prompts tell the model to ignore instructions inside the data. Do not post-process `report.html` in ways that reintroduce raw model HTML.
- **Truncated answers are failures.** An answer that stopped for any reason other than `STOP` is not cached and is reported, so a re-run requests it again.
- **Grounding bills per search, not per call.** The cost line reports grounded searches; a section typically runs 2–6.
- **The two engines read different webs.** Domain overlap between editions is typically 10–20%; low overlap is signal for the cross-check, not a defect.
- **Funding and valuation figures are the usual disagreement.** Aggregator sites publish rumored rounds as closed; prefer primary press, and say so.
- **Interrupts are clean.** SIGINT or SIGTERM to the tool stops its in-flight engine calls, frees the lock and exits 130; answers already validated stay cached.
- **Known limits.** The stale-lock takeover is safe for two simultaneous launches, not for three. An empty `run.lock` (crash mid-write) or a reused PID blocks runs until the file is removed by hand; check no run is live first.

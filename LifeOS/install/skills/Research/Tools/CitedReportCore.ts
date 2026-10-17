/**
 * CitedReportCore.ts — pure functions for CitedReport: citation placement and
 * numbering, source tiers, claim extraction, markdown and HTML rendering.
 * No I/O here; everything is unit-testable.
 */

import { createHash } from 'crypto'

// Citations travel as invisible-separator tokens until the final render, so a
// literal "[3]" in model prose or code is never mistaken for one of ours.
export const CITE = (n: number) => `⁣${n}⁣`
export const CITE_RE = /⁣(\d+)⁣/g
// One claim's citations, including Perplexity-style "[1], [2]" once tokenised.
const GROUP_RE = /⁣\d+⁣(?:[ \t,]*⁣\d+⁣)*/g
// Verification flags ride the same way, with U+2064.
export type FlagKind = 'partial' | 'unsupported' | 'removed'
export const FLAG = (v: FlagKind) => `⁤${v[0]}⁤`
const FLAG_RE = /⁤([pur])⁤/g

export interface PlanItem { title: string; query: string }
export interface Ref { n: number; url: string; domain: string }
export interface Support { segment?: { text?: string; endIndex?: number }; groundingChunkIndices?: number[] }
export interface Claim { id: number; claim: string; nums: number[]; end: number }
export type Tier = 'primary' | 'standard' | 'low' | 'deny'
export interface Tiers { primary: string[]; low: string[]; deny: string[] }

export const DEFAULT_TIERS: Tiers = {
  primary: ['.gov', '.gov.uk', '.edu', '.ac.uk', 'europa.eu', 'who.int', 'arxiv.org', 'doi.org', 'nature.com', 'science.org', 'acm.org', 'ieee.org', 'nih.gov'],
  low: ['pinterest.', 'quora.com', 'scribd.com', 'slideshare.net', 'coursehero.com', 'answers.com', 'ehow.com', 'wikihow.com'],
  deny: [],
}

export function shortHash(s: string, n = 10): string {
  return createHash('sha256').update(s).digest('hex').slice(0, n)
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'report'
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') || url.slice(0, 40) } catch { return url.slice(0, 40) }
}

/** Entry forms: ".gov" (suffix), "pinterest." (label prefix anywhere), "quora.com" (domain or subdomain). */
export function tierOf(domain: string, t: Tiers): Tier {
  const hit = (list: string[]) => list.some(e =>
    e.startsWith('.') ? domain.endsWith(e) : e.endsWith('.') ? `.${domain}`.includes(`.${e}`) : domain === e || domain.endsWith(`.${e}`))
  if (hit(t.deny)) return 'deny'
  if (hit(t.low)) return 'low'
  if (hit(t.primary)) return 'primary'
  return 'standard'
}

export function mergeTiers(base: Tiers, extra: Partial<Tiers> | undefined): Tiers {
  if (!extra) return base
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  return { primary: [...base.primary, ...arr(extra.primary)], low: [...base.low, ...arr(extra.low)], deny: [...base.deny, ...arr(extra.deny)] }
}

/** Same page, one number: drop the fragment and tracking parameters; URL() lowercases the host. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(k)) u.searchParams.delete(k)
    return u.toString()
  } catch { return raw }
}

/** One reference list per edition; numbers are provisional until renumberByAppearance. */
export class RefList {
  refs: Ref[] = []
  private byUrl = new Map<string, Ref>()
  number(raw: string): number {
    const url = normalizeUrl(raw)
    let r = this.byUrl.get(url)
    if (!r) {
      r = { n: this.refs.length + 1, url, domain: domainOf(url) }
      this.refs.push(r)
      this.byUrl.set(url, r)
    }
    return r.n
  }
  get(n: number): Ref | undefined { return this.refs[n - 1] }
}

/** Parse a plan from model output that may wrap the JSON array in prose or a code fence. */
export function parsePlan(raw: string, max: number): PlanItem[] {
  const arr = parseJsonArray(raw)
  if (!arr) throw new Error('plan: no JSON array found')
  const plan = arr
    .filter((x: any) => x && typeof x.title === 'string' && typeof x.query === 'string' && x.title.trim() && x.query.trim())
    .map((x: any) => ({ title: x.title.trim(), query: x.query.trim() }))
  if (plan.length < 2) throw new Error(`plan: only ${plan.length} usable sections`)
  if (plan.length > max) throw new Error(`plan: ${plan.length} sections exceeds the cap of ${max}`)
  return plan
}

export function parseJsonArray(raw: string): any[] | null {
  const start = raw.indexOf('['), end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try { const v = JSON.parse(raw.slice(start, end + 1)); return Array.isArray(v) ? v : null } catch { return null }
}

/**
 * Place a citation token after each grounded segment. The API's endIndex is a
 * UTF-8 byte offset into the full untrimmed text: it is the primary locator,
 * verified against the segment text. Text search is the fallback, scanning
 * forward from the previous placement so repeated phrases (table cells) each
 * get their own marker. Supports landing on one position are merged.
 */
export function injectCitations(text: string, supports: Support[], num: (chunk: number) => number | undefined): { text: string; marks: number } {
  const buf = Buffer.from(text, 'utf8')
  const at = new Map<number, Set<number>>()
  let cursor = 0
  for (const s of supports) {
    const seg = s.segment?.text
    if (!seg) continue
    const nums = (s.groundingChunkIndices ?? []).map(num).filter((n): n is number => n !== undefined)
    if (!nums.length) continue
    let pos = -1
    const end = s.segment?.endIndex
    if (typeof end === 'number' && end > 0 && end <= buf.length) {
      const p = buf.subarray(0, end).toString('utf8').length
      if (text.slice(p - seg.length, p) === seg) pos = p
    }
    if (pos === -1) {
      const i = text.indexOf(seg, cursor) !== -1 ? text.indexOf(seg, cursor) : text.indexOf(seg)
      if (i !== -1) pos = i + seg.length
    }
    if (pos === -1) continue
    cursor = pos
    const set = at.get(pos) ?? new Set<number>()
    nums.forEach(n => set.add(n))
    at.set(pos, set)
  }
  let out = text, marks = 0
  for (const pos of [...at.keys()].sort((a, b) => b - a)) {
    const ns = [...at.get(pos)!].sort((a, b) => a - b).slice(0, 6)
    marks += ns.length
    out = out.slice(0, pos) + ns.map(CITE).join('') + out.slice(pos)
  }
  return { text: out, marks }
}

// A backslash-escaped backtick is a literal in markdown, never the start of code.
const CODE_SPLIT = /((?<!\\)```[\s\S]*?```|~~~[\s\S]*?~~~|(?<!\\)`[^`\n]*`)/
/** Apply fn to markdown prose only, leaving fenced blocks and inline code untouched. */
export function outsideCode(md: string, fn: (prose: string) => string): string {
  return md.split(CODE_SPLIT).map((part, i) => (i % 2 ? part : fn(part))).join('')
}

/** Rewrite a section's local [k] markers (1-based into its own citation list) to tokens. */
export function renumberLocal(content: string, citations: string[], refs: RefList): { text: string; marks: number } {
  const map = citations.map(u => refs.number(u))
  let marks = 0
  const text = outsideCode(content, s => s.replace(/\[(\d{1,3})\](?!\()/g, (m, k: string) => {
    const g = map[Number(k) - 1]
    if (g === undefined) return m
    marks++
    return CITE(g)
  }))
  return { text, marks }
}

const stripSentinels = (s: string) => s.replace(/[⁣⁤]/g, '')

export function geminiText(d: any): string {
  return stripSentinels((d?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join(''))
}

export function validateGemini(d: any): string | null {
  const c = d?.candidates?.[0]
  if (!c) return `no candidates (${d?.promptFeedback?.blockReason ?? 'blocked or empty response'})`
  if (!geminiText(d).trim()) return `empty text (finishReason ${c.finishReason ?? 'unknown'})`
  if (c.finishReason && c.finishReason !== 'STOP') return `incomplete answer (finishReason ${c.finishReason})`
  return null
}

export function validatePerplexity(d: any): string | null {
  return typeof d?.content === 'string' && d.content.trim() ? null : 'empty content'
}

export function groundingUris(d: any): string[] {
  return (d?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((ch: any) => ch?.web?.uri ?? ch?.retrievedContext?.uri ?? '')
}

/** Google bills grounding per search the model runs, not per request. */
export function searchCount(d: any): number {
  const q = d?.candidates?.[0]?.groundingMetadata?.webSearchQueries
  return Array.isArray(q) ? q.length : 0
}

export function compileGemini(d: any, resolveUri: (u: string) => string, refs: RefList): { text: string; marks: number } {
  const uris = groundingUris(d)
  const num = (k: number) => (uris[k] ? refs.number(resolveUri(uris[k])) : undefined)
  const r = injectCitations(geminiText(d), d.candidates[0].groundingMetadata?.groundingSupports ?? [], num)
  return { text: r.text.trim(), marks: r.marks }
}

export function compilePerplexity(d: any, refs: RefList): { text: string; marks: number } {
  const r = renumberLocal(stripSentinels(d.content), Array.isArray(d.citations) ? d.citations : [], refs)
  return { text: r.text.trim(), marks: r.marks }
}

/**
 * Drop denied sources everywhere, and low-tier sources wherever the same claim
 * also has a better one. A claim left with only low-tier sources keeps them.
 */
export function applyTiers(text: string, tierOfRef: (n: number) => Tier): string {
  return text.replace(GROUP_RE, g => {
    const nums = [...g.matchAll(CITE_RE)].map(m => Number(m[1])).filter(n => tierOfRef(n) !== 'deny')
    if (!nums.length) return FLAG('removed')
    const better = nums.filter(n => tierOfRef(n) !== 'low')
    return (better.length ? better : nums).map(CITE).join('')
  })
}

/** Renumber citations in order of first appearance across texts; uncited sources are dropped. */
export function renumberByAppearance(texts: string[], refs: RefList): { texts: string[]; refs: RefList } {
  const map = new Map<number, number>()
  const out = new RefList()
  const texts2 = texts.map(t => t.replace(CITE_RE, (_, s) => {
    const old = Number(s)
    let n = map.get(old)
    if (n === undefined) {
      const r = refs.get(old)
      if (!r) return ''
      n = out.number(r.url)
      map.set(old, n)
    }
    return CITE(n)
  }))
  return { texts: texts2, refs: out }
}

export const MIN_CLAIM_CHARS = 15

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|ca|cf|Inc|Ltd|Corp|Co|Mr|Ms|Dr|St|No|Fig)|\b[A-Z](?:\.[A-Z])*)$/

/** Index just before the current sentence: the last ". ", "! ", "? " or newline that is not an abbreviation. */
function sentenceStart(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === '\n') return i
    if (s[i + 1] === ' ' && (s[i] === '!' || s[i] === '?' || (s[i] === '.' && !ABBREV.test(s.slice(Math.max(0, i - 12), i))))) return i + 1
  }
  return -1
}

const cleanClaim = (s: string) =>
  stripSentinels(s).replace(/[*_`#>]/g, '').replace(/^\s*(?:[-+]|\d+\.)\s+/, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Each citation group becomes one checkable claim: the sentence (or table row)
 * it closes, taken from the sentence start so a mid-sentence citation keeps its
 * subject. Every group yields a claim; the caller decides what is too short to
 * judge (MIN_CLAIM_CHARS) and counts it, rather than it silently vanishing.
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = []
  for (const m of text.matchAll(GROUP_RE)) {
    const start = m.index!, end = start + m[0].length
    const body = text.slice(0, start).replace(GROUP_RE, '').replace(FLAG_RE, '').replace(/\s+$/, '')
    const core = body.replace(/[.!?:;,]$/, '')
    const cut = sentenceStart(core)
    const claim = cleanClaim(body.slice(cut + 1))
    claims.push({ id: claims.length + 1, claim: claim.slice(0, 400), nums: [...new Set([...m[0].matchAll(CITE_RE)].map(x => Number(x[1])))], end })
  }
  return claims
}

/** Insert verification flags after the citation groups of partial / unsupported claims. */
export function applyVerdicts(text: string, claims: Claim[], verdicts: Map<number, string>): string {
  let out = text
  for (const c of [...claims].sort((a, b) => b.end - a.end)) {
    const v = verdicts.get(c.id)
    if (v === 'partial' || v === 'unsupported') out = out.slice(0, c.end) + FLAG(v) + out.slice(c.end)
  }
  return out
}

export interface SupportStats { supported: number; partial: number; unsupported: number; unavailable: number }
export function supportLine(s: SupportStats): string {
  const checked = s.supported + s.partial + s.unsupported
  const why = 'a cited page was unreachable or had no matching passage, the claim was too short, or its judge call failed'
  if (!checked) return `Citation check: no claims could be checked (${s.unavailable} not checkable: ${why})`
  const pct = (n: number) => `${Math.round((100 * n) / checked)}%`
  return `Citation check: ${pct(s.supported)} supported, ${pct(s.partial)} partial, ${pct(s.unsupported)} unsupported of ${checked} checked claims` +
    (s.unavailable ? `; ${s.unavailable} not checkable (${why})` : '')
}

export function buildMarkdown(o: {
  title: string; topic: string; method: string; summary?: string; sections: { title: string; text: string }[]
  notes?: string; refs: RefList; tierOfRef: (n: number) => Tier; date: string; checkLine?: string
}): string {
  const body = o.sections.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.text}`).join('\n\n---\n\n')
  const marks = [o.summary ?? '', o.notes ?? '', ...o.sections.map(s => s.text)].join('').match(CITE_RE)?.length ?? 0
  const tierLabel = (n: number) => ({ primary: ' · primary source', low: ' · low-tier', standard: '', deny: '' })[o.tierOfRef(n)]
  return `# ${o.title}

> **Research question:** ${o.topic}
>
> **Method:** ${o.method}. Generated ${o.date}. ${o.refs.refs.length} unique sources, ${marks} inline citations.${o.checkLine ? `\n>\n> **${o.checkLine}.** ⚠ marks a claim its cited sources did not support; ~ marks partial support; † marks a claim whose only sources were removed by the source policy.` : ''}
${o.summary ? `\n## Summary\n\n*Written from the sections below; the summary itself is not citation-checked.*\n\n${o.summary}\n` : ''}
${body}
${o.notes ? `\n---\n\n## Cross-section notes\n\n${o.notes}\n` : ''}
---

## References

${o.refs.refs.map(r => `${r.n}. ${refLink(r)}${tierLabel(r.n)}`).join('\n')}
`
}

/** Only web links become links; anything else (javascript:, file:) is shown as inert code. */
function refLink(r: Ref): string {
  if (!/^https?:\/\//i.test(r.url)) return `${r.domain.replace(/[[\]`]/g, '')} (\`${r.url.replace(/`/g, '').slice(0, 80)}\`)`
  return `[${r.domain.replace(/[[\]]/g, '')}](${r.url.replace(/[()<>\s]/g, c => encodeURIComponent(c))})`
}

const FLAG_TEXT: Record<string, string> = { u: '⚠', p: '~', r: '†' }
const plainTokens = (md: string) => md.replace(CITE_RE, (_, n) => `[${n}]`).replace(FLAG_RE, (_, f) => FLAG_TEXT[f])

/**
 * Markdown file form: tokens become plain [n], flags become ⚠ / ~ / †. Raw
 * HTML and images from model prose are neutralised, since report.md gets
 * opened in previewers that render both.
 */
export function finalizeMarkdown(md: string): string {
  return plainTokens(outsideCode(md, s => s.replace(/</g, '&lt;').replace(/!\[/g, '[').replace(/\]\(\s*(?!https?:\/\/|#)(?:[^()]|\([^()]*\))*\)/g, ']')))
}

const FLAG_HTML: Record<string, string> = {
  u: '<sup class="flag" title="The cited sources did not support this claim">⚠</sup>',
  p: '<sup class="flag partial" title="The cited sources only partly support this claim">~</sup>',
  r: '<sup class="flag partial" title="Its only sources were removed by the source policy">†</sup>',
}

export function renderHtml(md: string, title: string, refCount: number, footer: string): string {
  const mdApi = (Bun as any).markdown
  // Model output is untrusted (grounded pages can inject), so raw HTML is rendered as text.
  let body: string = mdApi?.html
    ? mdApi.html(md, { noHtmlBlocks: true, noHtmlSpans: true })
    : `<pre style="white-space:pre-wrap">${escapeHtml(plainTokens(md))}</pre>`
  body = body
    .replace(CITE_RE, (_, n) => Number(n) >= 1 && Number(n) <= refCount ? `<sup class="cite"><a href="#ref-${n}">${n}</a></sup>` : '')
    .replace(FLAG_RE, (_, f) => FLAG_HTML[f])
  const heading = body.lastIndexOf('<h2>References</h2>')
  const ol = heading === -1 ? -1 : body.indexOf('<ol>', heading)
  if (refCount > 0 && ol !== -1) {
    const close = body.indexOf('</ol>', ol)
    let k = 0
    body = body.slice(0, ol) + body.slice(ol, close).replace(/<li>/g, () => `<li id="ref-${++k}">`) + body.slice(close)
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#0f1419;--panel:#161b22;--text:#e6e8ea;--muted:#9aa4af;--accent:#20b8cd;--warn:#e3a008;--border:#2a313a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:1.9rem;line-height:1.25;letter-spacing:-.02em}
h2{font-size:1.35rem;margin-top:2.2em;padding-top:1em;border-top:1px solid var(--border)}
h3,h4{font-size:1.05rem;color:var(--accent)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
blockquote{margin:1.2em 0;padding:14px 18px;background:var(--panel);border-left:3px solid var(--accent);border-radius:6px;color:var(--muted)}
sup.cite a{display:inline-block;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 4px;margin:0 1px;font-size:.68em;color:var(--muted)}
sup.cite a:hover{color:var(--accent);border-color:var(--accent);text-decoration:none}
sup.flag{color:var(--warn);font-size:.75em;margin-left:2px;cursor:help}sup.flag.partial{opacity:.75}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9em}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left}
th{background:var(--panel)}
code,pre{background:var(--panel);border-radius:4px;font-size:.88em}
code{padding:2px 5px}pre{padding:12px;overflow-x:auto}
hr{border:0;border-top:1px solid var(--border);margin:2.5em 0}
li{margin:.3em 0}
footer{margin-top:4em;color:var(--muted);font-size:.85em;border-top:1px solid var(--border);padding-top:1.5em}
</style></head><body><main>
${body}
<footer>${escapeHtml(footer)}</footer>
</main></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

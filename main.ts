// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 5: the file's lines, and matching them at three tiers ----

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineMatches(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: `ctx` lines are in both, written as the file's own line. */
interface MatchedLine {
  text: string;
  ctx: boolean;
}

function reindent(text: string, f: string, p: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

function buildReplacement(lines: string[], pos: number, o: MatchedLine[], n: MatchedLine[], tier: number): string[] {
  const ctxIndexInO: number[] = [];
  o.forEach((e, k) => {
    if (e.ctx) ctxIndexInO.push(k);
  });
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!.text);
  }
  const out: string[] = [];
  let nCtx = 0;
  for (const e of n) {
    if (e.ctx) out.push(lines[pos + ctxIndexInO[nCtx++]!]!);
    else if (tier === 2) out.push(reindent(e.text, f, p));
    else out.push(e.text);
  }
  return out;
}

// ---- shared body lines (unified hunks and V4A chunks) ----

type BodyKind = 'ctx' | 'old' | 'new' | 'bslash';
interface BodyEntry {
  kind: BodyKind;
  text: string;
}

function bodyEntry(line: string): BodyEntry {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'bslash', text: line.slice(1) };
}

function splitBody(body: BodyEntry[]): { o: MatchedLine[]; n: MatchedLine[] } {
  const o: MatchedLine[] = [];
  const n: MatchedLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push({ text: e.text, ctx: true });
      n.push({ text: e.text, ctx: true });
    } else if (e.kind === 'old') o.push({ text: e.text, ctx: false });
    else if (e.kind === 'new') n.push({ text: e.text, ctx: false });
  }
  return { o, n };
}

/** A `\` line follows the hunk's last context or `+` line. */
function bodyNoEol(body: BodyEntry[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'bslash';
}

interface Hunk {
  a: number;
  body: BodyEntry[];
}

/** Apply one unified hunk to the model (SPEC.md section 6). */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): void {
  const { o, n } = splitBody(h.body);
  if (o.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, model.lines.length));
    const atEnd = ins === model.lines.length;
    const add = n.map((e) => e.text);
    model.lines.splice(ins, 0, ...add);
    if (atEnd && add.length > 0) model.final = !bodyNoEol(h.body);
    return;
  }
  const oTexts = o.map((e) => e.text);
  const found = findTier(model.lines, oTexts, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const atEnd = best + o.length === model.lines.length;
  const add = buildReplacement(model.lines, best, o, n, found.tier);
  model.lines.splice(best, o.length, ...add);
  if (atEnd) model.final = !bodyNoEol(h.body);
}

// ---- section 6: unified diffs ----

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseDiffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): Section => ({
    oldPath: null,
    newPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.oldPath = parseDiffPath(l);
        cur.newPath = parseDiffPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.oldPath = parseDiffPath(l);
        cur.newPath = parseDiffPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(bodyEntry(b));
          i++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) cur.newPath = parseDiffPath(l);
      else if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newP = s.newPath ?? s.renameTo ?? s.gitNew;
  if ((oldP === null && newP !== null) || (s.newFile && newP !== null)) {
    const target = newP!;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let lastHunk = -1;
      let lastIdx = -1;
      s.hunks.forEach((h, hi) => {
        h.body.forEach((e, ei) => {
          if (e.kind === 'new') {
            plus.push(e.text);
            lastHunk = hi;
            lastIdx = ei;
          }
        });
      });
      let noEol = false;
      if (lastHunk >= 0) {
        const h = s.hunks[lastHunk]!;
        noEol = h.body[lastIdx + 1] !== undefined && h.body[lastIdx + 1]!.kind === 'bslash';
      }
      const model: FileModel = { lines: plus, br: '\n', final: plus.length > 0 ? !noEol : false };
      tree.now.set(target, serializeFile(model));
    };
  }
  if ((newP === null && oldP !== null) || (s.deletedFile && oldP !== null)) {
    const target = oldP!;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = parseFile(before);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(model, h, d, strict, oldP);
        const { o, n } = splitBody(h.body);
        d += n.length - o.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(model));
      recordMove(oldP, newP);
    };
  }
  if (oldP !== null && newP !== null) {
    const target = oldP;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      const model = parseFile(before);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(model, h, d, strict, target);
        const { o, n } = splitBody(h.body);
        d += n.length - o.length;
      }
      tree.now.set(target, serializeFile(model));
    };
  }
  return () => {};
}

// ---- section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      const found = findTier(model.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const o: MatchedLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
      const n: MatchedLine[] = newLines.map((t) => ({ text: t, ctx: false }));
      const add = buildReplacement(model.lines, pos, o, n, found.tier);
      model.lines.splice(pos, oldLines.length, ...add);
      tree.now.set(p, serializeFile(model));
    });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- section 8: V4A patches ----

function v4aSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineMatches(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const startIdx = i;
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const sec: Array<{ text: string; idx: number }> = [];
    i++;
    while (i < last && v4aSectionStart(lines[i]!) === null) {
      sec.push({ text: lines[i]!, idx: i });
      i++;
    }
    while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of sec) {
        if (s.text === '') fileLines.push('');
        else if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else throw new Exit2(`error: parse ${s.idx + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'delete') {
      for (const s of sec) throw new Exit2(`error: parse ${s.idx + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (j < sec.length && sec[j]!.text.startsWith('*** Move to: ')) {
        moveTo = sec[j]!.text.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (; j < sec.length; j++) {
        const s = sec[j]!;
        const t = s.text;
        if (t === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${s.idx + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          continue;
        }
        if (t.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${s.idx + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
          }
          curChunk.body.push(bodyEntry(t));
          continue;
        }
        throw new Exit2(`error: parse ${s.idx + 1}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
      const p = path;
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const model = parseFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null && chunk.anchor !== '') {
            const pos = findAnchor(model.lines, chunk.anchor, cursor, strict);
            if (pos < 0) throw new Fail('no-match', p);
            cursor = pos + 1;
          }
          const { o, n } = splitBody(chunk.body);
          if (o.length === 0) {
            const ins = chunk.eof ? model.lines.length : cursor;
            const add = n.map((e) => e.text);
            model.lines.splice(ins, 0, ...add);
            cursor = ins + add.length;
            continue;
          }
          const oTexts = o.map((e) => e.text);
          const found = findTier(model.lines, oTexts, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          let pos: number;
          if (chunk.eof) {
            const ok = found.occ.filter((q) => q + o.length === model.lines.length);
            if (ok.length === 0) throw new Fail('no-match', p);
            pos = ok[0]!;
          } else {
            pos = found.occ[0]!;
          }
          const add = buildReplacement(model.lines, pos, o, n, found.tier);
          model.lines.splice(pos, o.length, ...add);
          cursor = pos + add.length;
        }
        const out = serializeFile(model);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, out);
          recordMove(p, mt);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

// ---- section 2: moves report as `R <old> -> <new>`, sorted by <new> ----

const recordedMoves: Array<{ old: string; new: string }> = [];

function recordMove(oldP: string, newP: string): void {
  recordedMoves.push({ old: oldP, new: newP });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  recordedMoves.length = 0;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const mv of recordedMoves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

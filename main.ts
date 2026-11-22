// mend: apply an AI-written edit to a tree of text files.
//
// One patch, four shapes: a unified diff, SEARCH/REPLACE blocks, a V4A patch,
// or JSON edit objects. The patch is read, every edit is tried against the
// tree as earlier edits left it, and either all of it lands or none of it
// does. SPEC.md is the contract; this file is its implementation.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse fault: exit 2 with this one line. */
class ParseExit {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that could not run: exit 1 reports `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r off each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class FileTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: FileTree) => void;

/** SPEC.md section 4: which format a patch is, or null when none matches. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function oneJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: FileTree): string => {
    if (!isSafePath(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const endsWithBreak = before !== '' && before.endsWith(br);
      if (endsWithBreak) lines.pop();
      if (line < 0 || line > lines.length) throw new EditFail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (endsWithBreak ? br : ''));
    };
  }
  return null;
}

/** The JSON edits of a patch (SPEC.md section 9): one array, or one object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseExit('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseExit(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseExit(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = oneJsonEdit(x);
      if (e === null) throw new ParseExit(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = oneJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseExit(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 5: a file's lines, and matching them at three tiers ----

interface TextFile {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into its lines, keeping its break and whether it ends with one. */
function parseText(text: string): TextFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Join a file's lines back to its text. */
function serializeText(m: TextFile): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripRight = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Are two lines the same at this tier? 0: exact, 1: trailing whitespace ignored, 2: both sides ignored. */
function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripRight(a) === stripRight(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position where the old lines occur in the file's lines at this tier, from `from` on. */
function findOccurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!linesEqual(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which the old lines occur, with every occurrence, or null when none does. */
function locateOld(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: `ctx` lines are in both, written as the file's own line. */
interface MatchedLine {
  text: string;
  ctx: boolean;
}

/** Re-indent one new line at tier 2: F is the file's first matched line's leading whitespace, P the old one's. */
function reindentLine(text: string, f: string, p: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** The lines N writes, replacing O at `pos`: context lines are the file's own, tier-2 lines re-indented. */
function makeReplacement(lines: string[], pos: number, o: MatchedLine[], n: MatchedLine[], tier: number): string[] {
  const ctxInO: number[] = [];
  o.forEach((e, k) => {
    if (e.ctx) ctxInO.push(k);
  });
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos]!);
    p = leadWs(o[0]!.text);
  }
  const out: string[] = [];
  let nCtx = 0;
  for (const e of n) {
    if (e.ctx) out.push(lines[pos + ctxInO[nCtx++]!]!);
    else if (tier === 2) out.push(reindentLine(e.text, f, p));
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

/** One body line: ' ' context, '-' old, '+' new, '\' a backslash line, empty a context line with no text. */
function readBodyLine(line: string): BodyEntry {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'bslash', text: line.slice(1) };
}

/** Split a body's lines into O (context + old) and N (context + new). */
function splitBodyLines(body: BodyEntry[]): { o: MatchedLine[]; n: MatchedLine[] } {
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

/** Does a `\` line follow the body's last context or `+` line? Then the result has no final break. */
function bodyEndsNoBreak(body: BodyEntry[]): boolean {
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
function applyHunk(model: TextFile, h: Hunk, d: number, strict: boolean, path: string): void {
  const { o, n } = splitBodyLines(h.body);
  if (o.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, model.lines.length));
    const atEnd = ins === model.lines.length;
    const add = n.map((e) => e.text);
    model.lines.splice(ins, 0, ...add);
    if (atEnd && add.length > 0) model.final = !bodyEndsNoBreak(h.body);
    return;
  }
  const oTexts = o.map((e) => e.text);
  const found = locateOld(model.lines, oTexts, strict);
  if (found === null) throw new EditFail('no-match', path);
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
  const add = makeReplacement(model.lines, best, o, n, found.tier);
  model.lines.splice(best, o.length, ...add);
  if (atEnd) model.final = !bodyEndsNoBreak(h.body);
}

// ---- section 6: unified diffs ----

interface DiffSection {
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

/** A `--- ` or `+++ ` path: text after the four characters, up to a tab, spaces removed, a/ or b/ removed, /dev/null as null. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The edits of a unified patch: one per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): DiffSection => ({
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
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new ParseExit(`error: parse ${i + 1}`);
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
        cur.oldPath = diffPath(l);
        cur.newPath = diffPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.oldPath = diffPath(l);
        cur.newPath = diffPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) {
      throw new ParseExit(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new ParseExit(`error: parse ${i + 1}`);
      if (cur === null) throw new ParseExit(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(readBodyLine(b));
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
      if (l.startsWith('+++ ')) cur.newPath = diffPath(l);
      else if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionToEdit(s, strict));
}

/** One section's edit: creation, deletion, move, or change of one path. */
function sectionToEdit(s: DiffSection, strict: boolean): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newP = s.newPath ?? s.renameTo ?? s.gitNew;
  if ((oldP === null && newP !== null) || (s.newFile && newP !== null)) {
    const target = newP!;
    return (tree) => {
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      if (tree.get(target) !== null) throw new EditFail('exists', target);
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
      const model: TextFile = { lines: plus, br: '\n', final: plus.length > 0 ? !noEol : false };
      tree.now.set(target, serializeText(model));
    };
  }
  if ((newP === null && oldP !== null) || (s.deletedFile && oldP !== null)) {
    const target = oldP!;
    return (tree) => {
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      if (tree.get(target) === null) throw new EditFail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
      if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new EditFail('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const model = parseText(before);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(model, h, d, strict, oldP);
        const { o, n } = splitBodyLines(h.body);
        d += n.length - o.length;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeText(model));
      recordMove(oldP, newP);
    };
  }
  if (oldP !== null && newP !== null) {
    const target = oldP;
    return (tree) => {
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      const before = tree.get(target);
      if (before === null) throw new EditFail('missing', target);
      const model = parseText(before);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(model, h, d, strict, target);
        const { o, n } = splitBodyLines(h.body);
        d += n.length - o.length;
      }
      tree.now.set(target, serializeText(model));
    };
  }
  return () => {};
}

// ---- section 7: SEARCH/REPLACE blocks ----

/** The edits of SEARCH/REPLACE blocks, in order. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
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
      if (isBlank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseExit(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new ParseExit(`error: parse ${searchIdx + 1}`);
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new ParseExit(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const model = parseText(before);
      const found = locateOld(model.lines, oldLines, strict);
      if (found === null) throw new EditFail('no-match', p);
      if (found.occ.length > 1) throw new EditFail('ambiguous', p);
      const pos = found.occ[0]!;
      const o: MatchedLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
      const n: MatchedLine[] = newLines.map((t) => ({ text: t, ctx: false }));
      const add = makeReplacement(model.lines, pos, o, n, found.tier);
      model.lines.splice(pos, oldLines.length, ...add);
      tree.now.set(p, serializeText(model));
    });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- section 8: V4A patches ----

/** What a `*** Add/Delete/Update File: ` line starts, or null. */
function v4aKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier with one, or -1. */
function findAnchorLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (linesEqual(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

/** The edits of a V4A patch. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseExit('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseExit(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseExit(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    const kind = v4aKind(l);
    if (kind === null) throw new ParseExit(`error: parse ${i + 1}`);
    const startIdx = i;
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const sec: Array<{ text: string; idx: number }> = [];
    i++;
    while (i < last && v4aKind(lines[i]!) === null) {
      sec.push({ text: lines[i]!, idx: i });
      i++;
    }
    while (sec.length > 0 && isBlank(sec[sec.length - 1]!.text)) sec.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of sec) {
        if (s.text === '') fileLines.push('');
        else if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else throw new ParseExit(`error: parse ${s.idx + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'delete') {
      for (const s of sec) throw new ParseExit(`error: parse ${s.idx + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (tree.get(p) === null) throw new EditFail('missing', p);
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
          if (curChunk === null) throw new ParseExit(`error: parse ${s.idx + 1}`);
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
            if (chunks.length > 0) throw new ParseExit(`error: parse ${s.idx + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
          }
          curChunk.body.push(readBodyLine(t));
          continue;
        }
        throw new ParseExit(`error: parse ${s.idx + 1}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new ParseExit(`error: parse ${startIdx + 1}`);
      const p = path;
      const mt = moveTo;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (mt !== null && !isSafePath(mt)) throw new EditFail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new EditFail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new EditFail('exists', mt);
        const model = parseText(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null && chunk.anchor !== '') {
            const pos = findAnchorLine(model.lines, chunk.anchor, cursor, strict);
            if (pos < 0) throw new EditFail('no-match', p);
            cursor = pos + 1;
          }
          const { o, n } = splitBodyLines(chunk.body);
          if (o.length === 0) {
            const ins = chunk.eof ? model.lines.length : cursor;
            const add = n.map((e) => e.text);
            model.lines.splice(ins, 0, ...add);
            cursor = ins + add.length;
            continue;
          }
          const oTexts = o.map((e) => e.text);
          const found = locateOld(model.lines, oTexts, strict, cursor);
          if (found === null) throw new EditFail('no-match', p);
          let pos: number;
          if (chunk.eof) {
            const ok = found.occ.filter((q) => q + o.length === model.lines.length);
            if (ok.length === 0) throw new EditFail('no-match', p);
            pos = ok[0]!;
          } else {
            pos = found.occ[0]!;
          }
          const add = makeReplacement(model.lines, pos, o, n, found.tier);
          model.lines.splice(pos, o.length, ...add);
          cursor = pos + add.length;
        }
        const out = serializeText(model);
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

/** Run the CLI on these arguments: exit code and stdout lines. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  // `--` ends the options: everything after it is a positional argument, even if it starts with `-`.
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
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  recordedMoves.length = 0;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseExit('error: parse 1');
  } catch (e) {
    if (e instanceof ParseExit) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new FileTree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
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

// Markdown chunker (CORE — pure; imports nothing outside src/knowledge). Heading-aware
// splitting into ≤512-token chunks with ~50-token overlap, using an approximate
// tokenizer (~chars/4). Each chunk carries its heading-path `section` and a 0-based
// `chunkIndex` (stable order → maps to agent_memory.chunk_index).
//
// ⚠︎ Keep a markdown TABLE atomic within one chunk (the Spanish docs are table-heavy):
// never split a table mid-rows; on an unavoidable continuation repeat the heading path
// (carried by `section`) and the table header row.

export interface Chunk {
  content: string;
  /** Heading path, e.g. 'Overview > Setup'. Empty string for pre-heading preamble. */
  section: string;
  chunkIndex: number;
}

export interface ChunkOptions {
  /** Max tokens per chunk (default 512). */
  maxTokens?: number;
  /** Overlap tokens carried between adjacent chunks (default 50). */
  overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;

interface Section {
  section: string;
  body: string[];
}

/** A packing unit: either a plain text line or an atomic (indivisible) table fragment. */
interface Unit {
  lines: string[];
  atomic: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** A markdown table separator row, e.g. `| --- | :--: |`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && /^[\s|:-]+$/.test(t) && t.includes('-') && t.includes('|');
}

/** Split the doc into sections keyed by their cumulative heading path. Fenced code
 *  blocks are pass-through so a `#` comment inside a fence is not read as a heading. */
function parseSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  const pathStack: Array<{ level: number; text: string }> = [];
  let current: Section = { section: '', body: [] };
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      current.body.push(line);
      continue;
    }

    if (!inFence) {
      const h = line.match(HEADING_RE);
      if (h) {
        sections.push(current);
        const level = h[1].length;
        const text = h[2].trim();
        // Pop any siblings/deeper headings, then descend into this one.
        while (pathStack.length && pathStack[pathStack.length - 1].level >= level) pathStack.pop();
        pathStack.push({ level, text });
        current = { section: pathStack.map((p) => p.text).join(' > '), body: [] };
        continue;
      }
    }

    current.body.push(line);
  }
  sections.push(current);
  return sections;
}

/** Break a table into ≤maxChars fragments, each repeating the header + separator row. */
function pushTableUnits(units: Unit[], table: string[], maxChars: number): void {
  const [header, separator, ...rows] = table;
  if (table.join('\n').length <= maxChars || rows.length === 0) {
    units.push({ lines: table, atomic: true });
    return;
  }
  let group: string[] = [];
  const flush = (): void => {
    if (group.length) units.push({ lines: [header, separator, ...group], atomic: true });
    group = [];
  };
  for (const row of rows) {
    const prospective = [header, separator, ...group, row].join('\n').length;
    if (group.length && prospective > maxChars) flush();
    group.push(row);
  }
  flush();
}

/** Turn a section body into packing units, keeping tables atomic (or header-repeated
 *  fragments when a single table exceeds maxChars). */
function buildUnits(body: string[], maxChars: number): Unit[] {
  const units: Unit[] = [];
  let inFence = false;
  let fenceMarker = '';
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      units.push({ lines: [line], atomic: false });
      i += 1;
      continue;
    }
    if (!inFence && line.includes('|') && i + 1 < body.length && isTableSeparator(body[i + 1])) {
      const table = [body[i], body[i + 1]];
      let j = i + 2;
      while (j < body.length && body[j].includes('|') && body[j].trim() !== '') {
        table.push(body[j]);
        j += 1;
      }
      pushTableUnits(units, table, maxChars);
      i = j;
      continue;
    }
    units.push({ lines: [line], atomic: false });
    i += 1;
  }
  return units;
}

/** Trailing whole lines whose total length stays within overlapChars (context carry). */
function overlapTail(lines: string[], overlapChars: number): string[] {
  if (overlapChars <= 0) return [];
  const out: string[] = [];
  let total = 0;
  for (let k = lines.length - 1; k >= 0; k--) {
    const add = lines[k].length + (out.length ? 1 : 0);
    if (out.length && total + add > overlapChars) break;
    out.unshift(lines[k]);
    total += add;
    if (total >= overlapChars) break;
  }
  return out;
}

/** Greedily pack a section's units into ≤maxChars chunks with line-granular overlap. */
function packUnits(units: Unit[], maxChars: number, overlapChars: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let dirty = false; // has real content been added since the last flush / the seed?

  for (const unit of units) {
    const unitChars = unit.lines.join('\n').length;
    const curChars = cur.join('\n').length;
    if (dirty && curChars + 1 + unitChars > maxChars) {
      const text = cur.join('\n').trim();
      if (text) chunks.push(text);
      cur = overlapTail(cur, overlapChars);
      dirty = false;
    }
    cur.push(...unit.lines);
    dirty = true;
  }
  if (dirty) {
    const text = cur.join('\n').trim();
    if (text) chunks.push(text);
  }
  return chunks;
}

export function chunkMarkdown(doc: { title: string; content: string }, opts?: ChunkOptions): Chunk[] {
  const maxTokens = opts?.maxTokens ?? 512;
  const overlapTokens = opts?.overlapTokens ?? 50;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const sections = parseSections(doc.content);
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  for (const section of sections) {
    const units = buildUnits(section.body, maxChars);
    for (const content of packUnits(units, maxChars, overlapChars)) {
      chunks.push({ content, section: section.section, chunkIndex: chunkIndex++ });
    }
  }
  return chunks;
}

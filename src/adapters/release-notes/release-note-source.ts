import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReleaseNote } from '../../outbound/release-note-notifier';

// Release-note SOURCE (ADAPTER — fs walk; the core notifier depends only on ReleaseNote).
// Reads *.md release notes under a configured directory. `key` (the idempotency id) is
// the repo-relative POSIX path; `title` is the first H1 (else the filename); `content`
// is the markdown with a leading H1 stripped. Deliberately tiny + defensive: a bad file
// is skipped (logged by the caller), never aborts the batch.

export interface ReleaseNoteSource {
  listNotes(): Promise<ReleaseNote[]>;
}

/** First markdown H1 (`# Title`) as the title, else null. */
function firstH1(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

export function buildReleaseNoteSource(rootDir: string): ReleaseNoteSource {
  const root = path.resolve(rootDir);
  return {
    async listNotes(): Promise<ReleaseNote[]> {
      const files = await walkMarkdown(root);
      const notes: ReleaseNote[] = [];
      for (const file of files.sort()) {
        const raw = await readFile(file, 'utf8');
        const rel = path.relative(root, file).split(path.sep).join('/');
        const title = firstH1(raw) ?? path.basename(file, path.extname(file));
        notes.push({ key: rel, title, content: raw.trim() });
      }
      return notes;
    },
  };
}

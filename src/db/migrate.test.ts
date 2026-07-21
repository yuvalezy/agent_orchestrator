import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMigrationFiles } from './migrate';

function fixture(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), sql);
  return directory;
}

test('loadMigrationFiles returns stable content checksums and numeric versions', () => {
  const directory = fixture({ '001_first.sql': 'SELECT 1;', '002_second.sql': 'SELECT 2;' });
  try {
    const files = loadMigrationFiles(directory);
    assert.deepEqual(files.map(({ name, version }) => ({ name, version })), [
      { name: '001_first.sql', version: 1 },
      { name: '002_second.sql', version: 2 },
    ]);
    assert.match(files[0]!.checksum, /^[a-f0-9]{64}$/);
    assert.notEqual(files[0]!.checksum, files[1]!.checksum);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loadMigrationFiles rejects duplicate future versions', () => {
  const directory = fixture({ '050_first.sql': 'SELECT 1;', '050_second.sql': 'SELECT 2;' });
  try {
    assert.throws(() => loadMigrationFiles(directory), /Duplicate migration version 50/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loadMigrationFiles accepts only the known duplicate legacy versions', () => {
  const directory = fixture({ '037_first.sql': 'SELECT 1;', '037_second.sql': 'SELECT 2;' });
  try {
    assert.equal(loadMigrationFiles(directory).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loadMigrationFiles rejects filenames without a strict numeric prefix', () => {
  const directory = fixture({ 'later.sql': 'SELECT 1;' });
  try {
    assert.throws(() => loadMigrationFiles(directory), /Invalid migration filename/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, parseAddresses, parseOneAddress, header, type GmailPayload } from './mime';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

test('extractText: single-part leaf (body at payload root, no parts) — DA note 3', () => {
  const p: GmailPayload = { mimeType: 'text/plain', body: { data: b64url('hello leaf') } };
  assert.equal(extractText(p), 'hello leaf');
});

test('extractText: multipart/alternative prefers text/plain', () => {
  const p: GmailPayload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('plain body') } },
      { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
    ],
  };
  assert.equal(extractText(p), 'plain body');
});

test('extractText: falls back to stripped text/html when no plain part', () => {
  const p: GmailPayload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: b64url('<style>x{}</style><p>Hi <b>there</b></p>') } }],
  };
  assert.equal(extractText(p), 'Hi there');
});

test('extractText: nested multipart/mixed finds the deep text/plain', () => {
  const p: GmailPayload = {
    mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64url('deep') } }] }],
  };
  assert.equal(extractText(p), 'deep');
});

test('extractText: no body → null', () => {
  assert.equal(extractText({ mimeType: 'multipart/mixed', parts: [] }), null);
});

test('parseAddresses handles display names + multiple + lowercasing', () => {
  assert.deepEqual(parseAddresses('Alice <Alice@Example.com>, bob@x.io'), ['alice@example.com', 'bob@x.io']);
  assert.deepEqual(parseAddresses(undefined), []);
  assert.equal(parseOneAddress('Reyel <lernerreyel@GMAIL.com>'), 'lernerreyel@gmail.com');
  assert.equal(parseOneAddress('not-an-email'), null);
});

test('header lookup is case-insensitive', () => {
  const p: GmailPayload = { headers: [{ name: 'Message-ID', value: '<abc@x>' }] };
  assert.equal(header(p, 'message-id'), '<abc@x>');
});

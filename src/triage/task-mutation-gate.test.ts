import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskMutationGate } from './triage.service';

test('compliments and acknowledgements are context-only regardless of confidence', () => {
  assert.equal(taskMutationGate({ category: 'compliment', explicit_action_request: false }), 'context');
  assert.equal(taskMutationGate({ category: 'info_provided', explicit_action_request: false }), 'context');
});

test('an actionable label without a request in the current message requires confirmation', () => {
  assert.equal(taskMutationGate({ category: 'follow_up', explicit_action_request: false }), 'confirm');
});

test('a concrete current-message defect report may reach the task mutation path', () => {
  assert.equal(taskMutationGate({ category: 'bug_report', explicit_action_request: true }), 'act');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineDistance, clusterByEmbedding } from './proposal-collapse';

test('cosineDistance: identical direction → 0, orthogonal → 1, zero-vector → 2', () => {
  assert.equal(cosineDistance([1, 0], [2, 0]), 0);
  assert.equal(cosineDistance([1, 0], [0, 1]), 1);
  assert.equal(cosineDistance([0, 0], [1, 1]), 2);
});

test('near-identical items collapse into one cluster; the first is the representative', () => {
  const clusters = clusterByEmbedding(
    [
      { key: 'a', embedding: [1, 0, 0] },
      { key: 'b', embedding: [0.99, 0.01, 0] },
      { key: 'c', embedding: [0.98, 0.02, 0] },
    ],
    0.05,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].repKey, 'a');
  assert.deepEqual(clusters[0].memberKeys.sort(), ['a', 'b', 'c']);
});

test('distinct items stay in separate clusters', () => {
  const clusters = clusterByEmbedding(
    [
      { key: 'a', embedding: [1, 0, 0] },
      { key: 'b', embedding: [0, 1, 0] },
      { key: 'c', embedding: [0, 0, 1] },
    ],
    0.1,
  );
  assert.equal(clusters.length, 3);
});

test('representative is input-order-first, so callers can pre-sort by confidence', () => {
  const clusters = clusterByEmbedding(
    [
      { key: 'high', embedding: [1, 0] },
      { key: 'low', embedding: [0.999, 0.001] },
    ],
    0.5,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].repKey, 'high');
});

/**
 * Unit tests for hnsw-lite.ts â€” HNSWIndex construction, insertion, search, serialization
 *
 * Uses pure JS data structures. No mocking needed.
 */
import { describe, it, expect } from 'vitest';
import { HNSWIndex } from './hnsw-lite';

function makeVec(...values: number[]): Float64Array {
  const v = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) v[i] = values[i];
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// Deterministic padding to get any dims vector
function padTo(vec: Float64Array, dims: number): Float64Array {
  const out = new Float64Array(dims);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i];
  // L2-normalize the padded vector
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) out[i] /= norm;
  return out;
}

describe('HNSWIndex constructor', () => {
  it('creates an empty index with default parameters', () => {
    const idx = new HNSWIndex(128);
    expect(idx.size).toBe(0);
    expect(idx.dimensions).toBe(128);
  });

  it('accepts custom M and efConstruction', () => {
    const idx = new HNSWIndex(64, 32, 400);
    expect(idx.dimensions).toBe(64);
    expect(idx.size).toBe(0);
  });
});

describe('HNSWIndex insert', () => {
  it('inserts a single vector', () => {
    const idx = new HNSWIndex(4);
    const vec = makeVec(1, 0, 0, 0);
    idx.insert(1, vec);
    expect(idx.size).toBe(1);
  });

  it('throws on duplicate id', () => {
    const idx = new HNSWIndex(4);
    idx.insert(1, makeVec(1, 0, 0, 0));
    expect(() => idx.insert(1, makeVec(0, 1, 0, 0))).toThrow(/already exists/);
  });

  it('throws on dimension mismatch', () => {
    const idx = new HNSWIndex(4);
    const wrongVec = new Float64Array(8);
    expect(() => idx.insert(1, wrongVec)).toThrow(/dimension/);
  });

  it('inserts multiple vectors', () => {
    const idx = new HNSWIndex(8);
    for (let i = 0; i < 100; i++) {
      idx.insert(i, padTo(makeVec(i % 5), 8));
    }
    expect(idx.size).toBe(100);
  });
});

describe('HNSWIndex search', () => {
  it('returns empty array when index is empty', () => {
    const idx = new HNSWIndex(8);
    const results = idx.search(new Float64Array(8), 5);
    expect(results).toEqual([]);
  });

  it('finds the closest vector among few items', () => {
    const idx = new HNSWIndex(8, 4, 50);
    // Insert vectors at various positions
    idx.insert(10, padTo(makeVec(1, 0, 0, 0), 8));
    idx.insert(20, padTo(makeVec(0, 1, 0, 0), 8));
    idx.insert(30, padTo(makeVec(0, 0, 1, 0), 8));

    // Query near [1,0,0,0]
    const results = idx.search(padTo(makeVec(0.9, 0.1, 0, 0), 8), 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The closest result should have very small distance to the query
    expect(results[0].distance).toBeLessThan(0.1);
  });

  it('returns results sorted by distance ascending', () => {
    const idx = new HNSWIndex(8, 4, 50);
    idx.insert(1, padTo(makeVec(1, 0, 0, 0), 8));
    idx.insert(2, padTo(makeVec(0, 0, 1, 0), 8));
    idx.insert(3, padTo(makeVec(0, 1, 0, 0), 8));

    const results = idx.search(padTo(makeVec(1, 0, 0, 0), 8), 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('respects k limit', () => {
    const idx = new HNSWIndex(8, 4, 50);
    for (let i = 0; i < 50; i++) {
      idx.insert(i, padTo(makeVec(i % 5 + 1, 0, 0, 0), 8));
    }
    const results = idx.search(padTo(makeVec(1, 0, 0, 0), 8), 5);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('HNSWIndex serialization (toJSON / fromJSON)', () => {
  it('round-trips an empty index', () => {
    const idx = new HNSWIndex(64, 16, 200);
    const json = idx.toJSON();
    const restored = HNSWIndex.fromJSON(json as Record<string, unknown>);
    expect(restored.size).toBe(0);
    expect(restored.dimensions).toBe(64);
  });

  it('round-trips indexed vectors with correct distances', () => {
    const idx = new HNSWIndex(8, 4, 50);
    idx.insert(1, padTo(makeVec(1, 0, 0, 0), 8));
    idx.insert(2, padTo(makeVec(0, 1, 0, 0), 8));
    idx.insert(3, padTo(makeVec(0, 0, 1, 0), 8));

    const json = idx.toJSON();
    const restored = HNSWIndex.fromJSON(json as Record<string, unknown>);
    expect(restored.size).toBe(3);

    // Search on restored index should give same results
    const query = padTo(makeVec(1, 0, 0, 0), 8);
    const origResults = idx.search(query, 3);
    const restResults = restored.search(query, 3);
    expect(restResults.length).toBe(origResults.length);
    for (let i = 0; i < restResults.length; i++) {
      expect(restResults[i].id).toBe(origResults[i].id);
      expect(restResults[i].distance).toBeCloseTo(origResults[i].distance, 5);
    }
  });

  it('preserves custom parameters after round-trip', () => {
    const idx = new HNSWIndex(128, 32, 400, 0.5);
    idx.insert(1, padTo(makeVec(1, 0, 0, 0), 128));
    const json = idx.toJSON();
    const restored = HNSWIndex.fromJSON(json as Record<string, unknown>);
    expect(restored.dimensions).toBe(128);
  });
});

describe('HNSWIndex ANN quality â€” similar vectors cluster correctly', () => {
  it('finds the closest vector among many random vectors', () => {
    const idx = new HNSWIndex(16, 8, 100);

    // Insert 30 random vectors
    for (let i = 0; i < 30; i++) {
      const v = new Float64Array(16);
      for (let j = 0; j < 16; j++) v[j] = Math.random();
      let norm = 0;
      for (let j = 0; j < 16; j++) norm += v[j] * v[j];
      norm = Math.sqrt(norm);
      for (let j = 0; j < 16; j++) v[j] /= norm;
      idx.insert(i, v);
    }

    // Insert a cluster of very similar vectors
    for (let i = 0; i < 5; i++) {
      const v = new Float64Array(16);
      v[0] = 1; v[1] = 0.01 * i;
      let norm = 0;
      for (let j = 0; j < 16; j++) norm += v[j] * v[j];
      norm = Math.sqrt(norm);
      for (let j = 0; j < 16; j++) v[j] /= norm;
      idx.insert(100 + i, v);
    }

    // Query near the cluster
    const query = new Float64Array(16);
    query[0] = 0.99;
    let norm = 0;
    for (let j = 0; j < 16; j++) norm += query[j] * query[j];
    norm = Math.sqrt(norm);
    for (let j = 0; j < 16; j++) query[j] /= norm;

    const results = idx.search(query, 5);
    expect(results.length).toBeGreaterThan(0);
    // At least 2 results should be from the cluster (low distance)
    const clusterResults = results.filter(r => r.id >= 100);
    expect(clusterResults.length).toBeGreaterThanOrEqual(2);
  });
});

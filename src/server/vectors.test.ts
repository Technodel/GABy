/**
 * Unit tests for vectors.ts â€” trigram hashing, text-to-vector, cosine similarity, serialization
 *
 * Pure functions, no mocking needed.
 */
import { describe, it, expect } from 'vitest';
import { textToVector, cosineSimilarity, serializeVector, deserializeVector } from './vectors';

describe('textToVector', () => {
  it('returns a Float64Array of default length 2000', () => {
    const vec = textToVector('hello world');
    expect(vec).toBeInstanceOf(Float64Array);
    expect(vec.length).toBe(2000);
  });

  it('returns a zero vector for empty input', () => {
    const vec = textToVector('');
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it('returns a zero vector for very short tokens (under 3 chars)', () => {
    const vec = textToVector('a b c');
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it('returns an L2-normalized vector (norm â‰ˆ 1)', () => {
    const vec = textToVector('the quick brown fox jumps over the lazy dog');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('produces similar vectors for similar text', () => {
    const a = textToVector('function add(a, b) { return a + b; }');
    const b = textToVector('function add(x, y) { return x + y; }');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it('produces less similar vectors for different text', () => {
    const a = textToVector('import React from "react"');
    const b = textToVector('def fibonacci(n): return n if n < 2 else fibonacci(n-1) + fibonacci(n-2)');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
  });

  it('handles custom dimensions', () => {
    const vec = textToVector('test', 100);
    expect(vec.length).toBe(100);
  });

  it('is deterministic â€” same input produces same vector', () => {
    const a = textToVector('const x = 42;');
    const b = textToVector('const x = 42;');
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it('tokenizes on non-alphanumeric characters', () => {
    const vec = textToVector('hello-world_foo.bar');
    let nonZero = 0;
    for (let i = 0; i < vec.length; i++) {
      if (vec[i] !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = textToVector('hello world');
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal zero/non-zero pair', () => {
    const a = new Float64Array(2000);
    const b = textToVector('something');
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles different-length vectors by using the shorter', () => {
    const a = new Float64Array(100);
    const b = new Float64Array(200);
    a[0] = 1; b[0] = 1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('handles all-zero vectors gracefully', () => {
    const a = new Float64Array(100);
    const b = new Float64Array(100);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('serialize / deserialize round-trip', () => {
  it('preserves vector data through serializeâ†’deserialize', () => {
    const original = textToVector('test vector round trip');
    const serialized = serializeVector(original);
    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);

    const restored = deserializeVector(serialized, 2000);
    expect(restored).toBeInstanceOf(Float64Array);
    expect(restored.length).toBe(2000);

    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBe(original[i]);
    }
  });

  it('round-trips with custom dimensions', () => {
    const original = textToVector('custom dims', 100);
    const serialized = serializeVector(original);
    const restored = deserializeVector(serialized, 100);
    expect(restored.length).toBe(100);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBe(original[i]);
    }
  });

  it('produces consistent base64 output for same input', () => {
    const a = textToVector('consistency');
    const b = textToVector('consistency');
    expect(serializeVector(a)).toBe(serializeVector(b));
  });
});

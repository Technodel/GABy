/**
 * vectors.ts â€” Text-to-vector conversion using character trigram hashing.
 *
 * Pure JS, zero external dependencies. Converts any text into a sparse
 * vector (Map<string, number>) where dimensions are trigram hashes and
 * values are normalized TF weights.
 *
 * Ruflo-inspired: provides the embedding primitive for HNSW vector search.
 */

const TRIGRAM_REGEX = /[a-z0-9_]+/g;
const TRIGRAM_MIN_LEN = 3;
const TRIGRAM_MAX_DIMS = 2000;

/**
 * Hash a trigram string to a numeric dimension index (0..maxDims-1).
 * Uses FNV-1a 32-bit hash for fast, well-distributed results.
 */
function hashTrigram(tri: string, maxDims: number): number {
  let hash = 2166136261;
  for (let i = 0; i < tri.length; i++) {
    hash ^= tri.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % maxDims;
}

/**
 * Convert text to a sparse vector represented as a Float64Array of length dims.
 *
 * Algorithm:
 * 1. Tokenize into alphanumeric words (lowercased)
 * 2. For each word, extract all character trigrams
 * 3. Hash each trigram to a dimension index
 * 4. Count TF (term frequency) per dimension
 * 5. L2-normalize the vector
 */
export function textToVector(text: string, dims: number = TRIGRAM_MAX_DIMS): Float64Array {
  const vec = new Float64Array(dims);
  const tokens = text.toLowerCase().match(TRIGRAM_REGEX) || [];

  for (const token of tokens) {
    if (token.length < TRIGRAM_MIN_LEN) continue;
    // Extract all overlapping trigrams
    const limit = token.length - 2;
    for (let i = 0; i < limit; i++) {
      const tri = token.slice(i, i + 3);
      const idx = hashTrigram(tri, dims);
      vec[idx] += 1;
    }
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a Float64Array to a compact base64 string for DB storage.
 */
export function serializeVector(vec: Float64Array): string {
  const bytes = new Uint8Array(vec.buffer);
  // Base64 encode using btoa with binary string intermediate
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Deserialize a base64 string back to a Float64Array.
 */
export function deserializeVector(str: string, dims: number = TRIGRAM_MAX_DIMS): Float64Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float64Array(bytes.buffer);
}

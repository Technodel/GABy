/**
 * hnsw-lite.ts — Minimal HNSW (Hierarchical Navigable Small World) graph.
 *
 * Pure JS, zero external dependencies. Provides ANN (approximate nearest
 * neighbor) search over Float64Array vectors using a multi-layer graph.
 *
 * Ruflo-inspired: replaces brute-force keyword overlap with proper
 * vector similarity search for interaction memory retrieval.
 *
 * ── How HNSW works ──
 * HNSW builds a multi-layer graph where higher layers have fewer nodes
 * (long-range connections) and lower layers have more nodes (short-range).
 * Search starts at the top layer and descends, greedily following the
 * nearest neighbor at each step. This gives O(log N) search instead of O(N).
 *
 * ── API ──
 *   const index = new HNSWIndex(dims, M, efConstruction);
 *   index.insert(id, vector);          // add a vector
 *   index.search(query, k);            // find k nearest neighbors
 *   index.size                         // number of indexed items
 *   index.toJSON() / HNSWIndex.fromJSON()  // serialize/deserialize
 */

const DEFAULT_M = 16;           // max connections per node per layer
const DEFAULT_EF_CONSTRUCTION = 200;  // dynamic candidate list during construction
const DEFAULT_EF_SEARCH = 50;         // dynamic candidate list during search
const DEFAULT_LEVEL_MULTIPLIER = 1 / Math.LN2; // mL parameter — ln(2) ≈ 0.693

// ── Distance function ─────────────────────────────────────────────────────────

function cosineDist(a: Float64Array, b: Float64Array): number {
  return 1 - cosineSimilarity(a, b);
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HNSWNode {
  id: number;
  vector: Float64Array;
  level: number;
  connections: Map<number, Set<number>>;  // level → set of node IDs
}

export interface SearchResult {
  id: number;
  distance: number;
}

// ── Priority queue for search ─────────────────────────────────────────────────

class DistQueue {
  private items: Array<{ id: number; dist: number }> = [];

  get length(): number { return this.items.length; }

  push(id: number, dist: number): void {
    this.items.push({ id, dist });
  }

  popClosest(): { id: number; dist: number } | undefined {
    if (this.items.length === 0) return undefined;
    let minIdx = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].dist < this.items[minIdx].dist) minIdx = i;
    }
    const result = this.items[minIdx];
    this.items[minIdx] = this.items[this.items.length - 1];
    this.items.pop();
    return result;
  }

  popFarthest(): { id: number; dist: number } | undefined {
    if (this.items.length === 0) return undefined;
    let maxIdx = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].dist > this.items[maxIdx].dist) maxIdx = i;
    }
    const result = this.items[maxIdx];
    this.items[maxIdx] = this.items[this.items.length - 1];
    this.items.pop();
    return result;
  }

  peekFarthest(): { id: number; dist: number } | undefined {
    if (this.items.length === 0) return undefined;
    let maxIdx = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].dist > this.items[maxIdx].dist) maxIdx = i;
    }
    return this.items[maxIdx];
  }

  toResultArray(limit: number): SearchResult[] {
    return this.items
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit)
      .map(item => ({ id: item.id, distance: item.dist }));
  }
}

// ── HNSW Index ────────────────────────────────────────────────────────────────

export class HNSWIndex {
  private nodes: Map<number, HNSWNode> = new Map();
  private entryPoint: number | null = null;
  private readonly dims: number;
  private readonly M: number;
  private readonly MMax: number;
  private readonly MMax0: number;
  private readonly efConstruction: number;
  private readonly levelMultiplier: number;
  private maxLevel: number = -1;  // highest level currently in the graph

  constructor(
    dims: number,
    M: number = DEFAULT_M,
    efConstruction: number = DEFAULT_EF_CONSTRUCTION,
    levelMultiplier: number = DEFAULT_LEVEL_MULTIPLIER,
  ) {
    this.dims = dims;
    this.M = M;
    this.MMax = M;          // max connections for non-zero layers
    this.MMax0 = 2 * M;     // max connections for level 0 (more connections at base)
    this.efConstruction = efConstruction;
    this.levelMultiplier = levelMultiplier;
  }

  get size(): number {
    return this.nodes.size;
  }

  get dimensions(): number {
    return this.dims;
  }

  // ── Insert ────────────────────────────────────────────────────────────────

  insert(id: number, vector: Float64Array): void {
    if (this.nodes.has(id)) {
      throw new Error(`Node ${id} already exists`);
    }
    if (vector.length !== this.dims) {
      throw new Error(`Vector dimension mismatch: expected ${this.dims}, got ${vector.length}`);
    }

    // Random level using exponential distribution
    const level = this.randomLevel();
    const node: HNSWNode = {
      id,
      vector,
      level,
      connections: new Map(),
    };

    // Initialize connection sets for each level up to node's level
    for (let lvl = 0; lvl <= level; lvl++) {
      node.connections.set(lvl, new Set());
    }

    this.nodes.set(id, node);

    if (this.entryPoint === null) {
      // First node
      this.entryPoint = id;
      this.maxLevel = level;
      return;
    }

    // Find entry point at the top level
    let currEntry = this.entryPoint;
    let currNode = this.nodes.get(currEntry)!;

    // Greedy search from top level down to level+1
    for (let lvl = this.maxLevel; lvl > level; lvl--) {
      const changed = this.searchLayerGreedy(vector, currEntry, 1, lvl);
      if (changed.length > 0) {
        currEntry = changed[0].id;
      }
    }

    // Connect at levels 0..level
    for (let lvl = Math.min(level, this.maxLevel); lvl >= 0; lvl--) {
      const nearest = this.searchLayer(vector, currEntry, this.efConstruction, lvl);

      // Get top M neighbors
      const neighbors = nearest
        .sort((a, b) => a.dist - b.dist)
        .slice(0, this.M);

      const maxConn = lvl === 0 ? this.MMax0 : this.MMax;

      // Add connections from new node to neighbors
      for (const n of neighbors) {
        const neighborNode = this.nodes.get(n.id);
        if (!neighborNode) continue;

        // New node → neighbor
        node.connections.get(lvl)!.add(n.id);

        // Neighbor → new node
        if (neighborNode.connections.has(lvl)) {
          neighborNode.connections.get(lvl)!.add(id);

          // Shrink connections if over capacity
          if (neighborNode.connections.get(lvl)!.size > maxConn) {
            this.shrinkConnections(neighborNode, lvl, maxConn);
          }
        }
      }

      currEntry = id;
    }

    // Update max level if this node is higher
    if (level > this.maxLevel) {
      this.maxLevel = level;
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  search(query: Float64Array, k: number = 10, ef: number = DEFAULT_EF_SEARCH): SearchResult[] {
    if (this.entryPoint === null || this.nodes.size === 0) return [];

    let currEntry = this.entryPoint;

    // Traverse from top level down to level 0
    for (let lvl = this.maxLevel; lvl > 0; lvl--) {
      const changed = this.searchLayerGreedy(query, currEntry, 1, lvl);
      if (changed.length > 0) {
        currEntry = changed[0].id;
      }
    }

    // Search at level 0 with ef candidates
    const candidates = this.searchLayer(query, currEntry, Math.max(ef, k), 0);

    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  // ── Internal search helpers ───────────────────────────────────────────────

  private searchLayerGreedy(
    query: Float64Array,
    entryId: number,
    topK: number,
    level: number,
  ): SearchResult[] {
    const visited = new Set<number>();
    const candidates = new DistQueue();
    const results = new DistQueue();

    candidates.push(entryId, cosineDist(query, this.nodes.get(entryId)!.vector));
    results.push(entryId, cosineDist(query, this.nodes.get(entryId)!.vector));
    visited.add(entryId);

    while (candidates.length > 0) {
      const closest = candidates.popClosest();
      if (!closest) break;

      const farthest = results.peekFarthest();
      if (farthest && closest.dist > farthest.dist) break;

      const node = this.nodes.get(closest.id);
      if (!node) continue;

      const connections = node.connections.get(level);
      if (!connections) continue;

      for (const neighborId of connections) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = cosineDist(query, neighborNode.vector);
        const farthestResult = results.peekFarthest();
        if (farthestResult === undefined || dist < farthestResult.dist || results.length < topK) {
          candidates.push(neighborId, dist);
          results.push(neighborId, dist);
          // Trim results to topK
          if (results.length > topK) {
            results.popFarthest();
          }
        }
      }
    }

    return results.toResultArray(topK);
  }

  private searchLayer(
    query: Float64Array,
    entryId: number,
    ef: number,
    level: number,
  ): SearchResult[] {
    const visited = new Set<number>();
    const candidates = new DistQueue();
    const results = new DistQueue();

    candidates.push(entryId, cosineDist(query, this.nodes.get(entryId)!.vector));
    results.push(entryId, cosineDist(query, this.nodes.get(entryId)!.vector));
    visited.add(entryId);

    while (candidates.length > 0) {
      const closest = candidates.popClosest();
      if (!closest) break;

      const farthest = results.peekFarthest();
      if (farthest && closest.dist > farthest.dist) break;

      const node = this.nodes.get(closest.id);
      if (!node) continue;

      const connections = node.connections.get(level);
      if (!connections) continue;

      for (const neighborId of connections) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = cosineDist(query, neighborNode.vector);
        const farthestResult = results.peekFarthest();
        if (farthestResult === undefined || dist < farthestResult.dist || results.length < ef) {
          candidates.push(neighborId, dist);
          results.push(neighborId, dist);
          // Trim to ef
          if (results.length > ef) {
            results.popFarthest();
          }
        }
      }
    }

    return results.toResultArray(results.length);
  }

  // ── Connection management ─────────────────────────────────────────────────

  private shrinkConnections(node: HNSWNode, level: number, maxConn: number): void {
    const conns = node.connections.get(level);
    if (!conns || conns.size <= maxConn) return;

    // If over capacity, remove farthest connections
    const entries = Array.from(conns);
    const dists = entries.map(id => ({
      id,
      dist: cosineDist(node.vector, this.nodes.get(id)!.vector),
    }));
    dists.sort((a, b) => b.dist - a.dist); // farthest first

    const toRemove = dists.slice(maxConn);
    for (const r of toRemove) {
      conns.delete(r.id);
    }
  }

  // ── Level generation ──────────────────────────────────────────────────────

  private randomLevel(): number {
    // Exponential distribution: P(level) = exp(-level / mL) / mL
    const r = Math.random();
    return Math.floor(-Math.log(r) * this.levelMultiplier);
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): Record<string, unknown> {
    const serializedNodes = Array.from(this.nodes.entries()).map(([id, node]) => ({
      id,
      vector: Array.from(node.vector),
      level: node.level,
      connections: Array.from(node.connections.entries()).map(([level, conns]) => ({
        level,
        neighbors: Array.from(conns),
      })),
    }));

    return {
      dims: this.dims,
      M: this.M,
      efConstruction: this.efConstruction,
      levelMultiplier: this.levelMultiplier,
      maxLevel: this.maxLevel,
      entryPoint: this.entryPoint,
      nodes: serializedNodes,
    };
  }

  static fromJSON(data: Record<string, unknown>): HNSWIndex {
    const index = new HNSWIndex(
      data.dims as number,
      data.M as number,
      data.efConstruction as number,
      data.levelMultiplier as number,
    );

    index.maxLevel = data.maxLevel as number;
    index.entryPoint = data.entryPoint as number | null;

    const serializedNodes = data.nodes as Array<{
      id: number;
      vector: number[];
      level: number;
      connections: Array<{ level: number; neighbors: number[] }>;
    }>;

    for (const sn of serializedNodes) {
      const node: HNSWNode = {
        id: sn.id,
        vector: new Float64Array(sn.vector),
        level: sn.level,
        connections: new Map(),
      };
      for (const conn of sn.connections) {
        node.connections.set(conn.level, new Set(conn.neighbors));
      }
      index.nodes.set(sn.id, node);
    }

    return index;
  }
}

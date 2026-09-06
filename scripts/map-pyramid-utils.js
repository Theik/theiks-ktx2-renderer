const LEGACY_TIERS = [
  {id: "z0", density: 0.5},
  {id: "z1", density: 1},
  {id: "z2", density: 2}
];

export function sortTiersByDensity(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) throw new Error("A pyramid must contain at least one tier.");
  const sorted = [...tiers].sort((left, right) => Number(left.density) - Number(right.density));
  for (let index = 0; index < sorted.length; index += 1) {
    const density = Number(sorted[index].density);
    if (!Number.isFinite(density) || density <= 0) {
      throw new Error(`${sorted[index].id ?? `Tier ${index}`} has an invalid density.`);
    }
    if (index && density <= Number(sorted[index - 1].density)) {
      throw new Error("Pyramid tier densities must be unique.");
    }
  }
  return sorted;
}

export function validateAscendingTierDensities(tiers, sceneGridSize = 1) {
  let previous = 0;
  return tiers.map((tier, index) => {
    const density = Number(tier.density ?? (tier.gridPixels / sceneGridSize));
    if (!Number.isFinite(density) || density <= previous) {
      throw new Error(`Tier ${tier.id ?? index} densities must be strictly ascending.`);
    }
    previous = density;
    return density;
  });
}

export function semanticTier(tiers, mode) {
  const sorted = sortTiersByDensity(tiers);
  if (mode === "z0") return sorted[0].id;
  if (mode === "z2") return sorted.at(-1).id;
  if (mode === "z1") {
    return sorted.reduce((best, tier) => {
      const distance = Math.abs(Number(tier.density) - 1);
      const bestDistance = Math.abs(Number(best.density) - 1);
      return distance < bestDistance || (distance === bestDistance && tier.density > best.density) ? tier : best;
    }).id;
  }
  throw new Error(`Unknown LOD mode: ${mode}`);
}

export function selectLod(effectiveScale, previousTier = null, forcedMode = "auto", tiers = LEGACY_TIERS) {
  if (!forcedMode) forcedMode = "auto";
  const sorted = sortTiersByDensity(tiers);
  if (["z0", "z1", "z2"].includes(forcedMode)) return semanticTier(sorted, forcedMode);
  if (forcedMode !== "auto") throw new Error(`Unknown LOD mode: ${forcedMode}`);
  const scale = Number(effectiveScale);
  let index = sorted.findIndex(tier => tier.id === previousTier);
  if (index < 0) index = 0;

  if (previousTier) {
    while (index > 0 && scale < (0.3825 * Number(sorted[index].density))) index -= 1;
  }
  while (index < sorted.length - 1 && scale >= (0.45 * Number(sorted[index + 1].density))) index += 1;
  return sorted[index].id;
}

export function rectanglesIntersect(a, b) {
  return a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y;
}

export function selectVisibleTiles(tiles, viewport, margin = 0) {
  const expanded = {
    x: viewport.x - margin,
    y: viewport.y - margin,
    width: viewport.width + (2 * margin),
    height: viewport.height + (2 * margin)
  };
  return tiles.filter(tile => rectanglesIntersect(tile.scene, expanded));
}

export function selectTileDemand(tiles, viewport, prefetchMargin) {
  const visible = selectVisibleTiles(tiles, viewport);
  const visibleIds = new Set(visible.map(tile => tile.id));
  return {
    visible,
    prefetched: selectVisibleTiles(tiles, viewport, prefetchMargin).filter(tile => !visibleIds.has(tile.id))
  };
}

export function intersectRectangles(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return {x, y, width: rightEdge - x, height: bottomEdge - y};
}

export function mapSceneRectToTileFrame(tile, sceneRect) {
  const intersection = intersectRectangles(tile.scene, sceneRect);
  if (!intersection) return null;
  const scaleX = tile.frame.width / tile.scene.width;
  const scaleY = tile.frame.height / tile.scene.height;
  return {
    scene: intersection,
    frame: {
      x: tile.frame.x + ((intersection.x - tile.scene.x) * scaleX),
      y: tile.frame.y + ((intersection.y - tile.scene.y) * scaleY),
      width: intersection.width * scaleX,
      height: intersection.height * scaleY
    }
  };
}

export function resolveDisplaySlot(levelId, tiers, desiredTierId, desiredTile, loadedKeys) {
  if (desiredTile.blank) return {mode: "blank", pieces: []};
  const desiredIndex = tiers.findIndex(tier => tier.id === desiredTierId);
  if (desiredIndex < 0) throw new Error(`Unknown desired tier ${desiredTierId}.`);
  const targetKey = `${levelId}/${desiredTierId}/${desiredTile.id}`;
  if (loadedKeys.has(targetKey)) {
    return {mode: "target", pieces: [{key: targetKey, tile: desiredTile, scene: desiredTile.scene, frame: desiredTile.frame}]};
  }
  for (let index = desiredIndex - 1; index >= 0; index -= 1) {
    const tier = tiers[index];
    const pieces = [];
    let coveredArea = 0;
    let available = true;
    for (const tile of tier.tiles) {
      const mapped = mapSceneRectToTileFrame(tile, desiredTile.scene);
      if (!mapped) continue;
      coveredArea += mapped.scene.width * mapped.scene.height;
      const key = `${levelId}/${tier.id}/${tile.id}`;
      if (!tile.blank && !loadedKeys.has(key)) {
        available = false;
        break;
      }
      pieces.push({key: tile.blank ? null : key, tile, ...mapped});
    }
    const targetArea = desiredTile.scene.width * desiredTile.scene.height;
    if (available && Math.abs(coveredArea - targetArea) < 0.01) return {mode: "fallback", pieces};
  }
  return {mode: "uncovered", pieces: []};
}

export function retryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Retry attempt must be a positive integer.");
  return [5_000, 15_000, 60_000][Math.min(attempt - 1, 2)];
}

const BLANK_ASSET_FIELDS = [
  "path", "encoding", "ssim", "ssimBelowTarget", "bytes", "sha256", "mipLevels", "premultipliedAlpha"
];

export function validateManifestTileEntry(tile) {
  if (!tile?.id || !tile.scene || !tile.pixel || !tile.frame) throw new Error("Manifest tile geometry is incomplete.");
  if (tile.blank === true) {
    const unexpected = BLANK_ASSET_FIELDS.filter(field => Object.hasOwn(tile, field));
    if (unexpected.length) throw new Error(`${tile.id}: blank tile includes asset fields: ${unexpected.join(", ")}.`);
    return tile;
  }
  if (tile.blank !== undefined) throw new Error(`${tile.id}: blank must be true when present.`);
  if (!tile.path) throw new Error(`${tile.id}: tile path is missing.`);
  return tile;
}

export function performanceLoadConcurrency(mode) {
  const normalized = String(mode ?? "").toLowerCase();
  if (normalized === "0" || normalized === "low") return 1;
  if (normalized === "1" || normalized === "medium" || normalized === "med") return 2;
  return 4;
}

export class QueueCancelledError extends Error {
  constructor(message = "Texture request left the current demand set.") {
    super(message);
    this.name = "QueueCancelledError";
  }
}

export class PriorityLoadQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.pending = new Map();
    this.inFlight = new Set();
    this.sequence = 0;
  }

  setConcurrency(concurrency) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.#drain();
  }

  setPriority(key, priority) {
    const entry = this.pending.get(key);
    if (entry) entry.priority = priority;
  }

  enqueue(key, priority, task) {
    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      this.#drain();
      return existing.promise;
    }
    if (this.inFlight.has(key)) return null;
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.pending.set(key, {key, priority, task, promise, resolve, reject, sequence: this.sequence++});
    this.#drain();
    return promise;
  }

  cancelWhere(predicate) {
    let count = 0;
    for (const [key, entry] of this.pending) {
      if (!predicate(entry)) continue;
      this.pending.delete(key);
      entry.reject(new QueueCancelledError());
      count += 1;
    }
    return count;
  }

  get queuedCount() {
    return this.pending.size;
  }

  get inFlightCount() {
    return this.inFlight.size;
  }

  #drain() {
    while (this.inFlight.size < this.concurrency && this.pending.size) {
      const next = [...this.pending.values()].sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)[0];
      this.pending.delete(next.key);
      this.inFlight.add(next.key);
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.inFlight.delete(next.key);
          this.#drain();
        });
    }
  }
}

export function canvasRectToSceneRect(rect, sceneRect) {
  return {
    x: rect.x - sceneRect.x,
    y: rect.y - sceneRect.y,
    width: rect.width,
    height: rect.height
  };
}

export function scenePointToCanvasPoint(point, sceneRect) {
  return {
    x: point.x + sceneRect.x,
    y: point.y + sceneRect.y
  };
}

export function resolveNativeLevelId(mesh, levels) {
  const directId = mesh?.level?.id ?? mesh?.document?.id ?? mesh?.levelId;
  if (directId) return directId;
  const match = /^Level\.(\d+)\.background$/.exec(mesh?.name ?? "");
  if (!match) return null;
  const index = Number(match[1]);
  return levels.find(level => Number(level.index) === index)?.id ?? null;
}

export function levelBottomElevation(level) {
  return Number(level?.elevation?.bottom ?? 0);
}

export function orderedVisibleLevelIds(levels, activeLevelId) {
  const list = [...levels];
  const active = list.find(level => level?.id === activeLevelId);
  if (!active) return activeLevelId ? [activeLevelId] : [];
  const related = list
    .filter(level => level?.id && level.id !== active.id && level.isVisible)
    .sort((left, right) => {
      const byElevation = levelBottomElevation(right) - levelBottomElevation(left);
      if (byElevation) return byElevation;
      return Number(left.sort ?? 0) - Number(right.sort ?? 0);
    })
    .map(level => level.id);
  return [active.id, ...related];
}

export function visibleSceneLevelIds(levels, activeLevelId) {
  return new Set(orderedVisibleLevelIds(levels, activeLevelId));
}

export class ByteLruCache {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, bytes, pinnedKeys = new Set()) {
    this.delete(key);
    this.entries.set(key, {value, bytes});
    this.totalBytes += bytes;
    return this.evict(pinnedKeys);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    return entry.value;
  }

  evict(pinnedKeys = new Set()) {
    const evicted = [];
    for (const [key] of this.entries) {
      if (this.totalBytes <= this.maximumBytes) break;
      if (pinnedKeys.has(key)) continue;
      evicted.push([key, this.delete(key)]);
    }
    return evicted;
  }

  clear() {
    const values = [...this.entries.values()].map(entry => entry.value);
    this.entries.clear();
    this.totalBytes = 0;
    return values;
  }
}

export class RequestGeneration {
  constructor() {
    this.current = 0;
  }

  next() {
    this.current += 1;
    return this.current;
  }

  isCurrent(value) {
    return value === this.current;
  }

  assertCurrent(value) {
    if (!this.isCurrent(value)) throw new StaleRequestError();
  }
}

export class StaleRequestError extends Error {
  constructor(message = "Texture request was superseded by a newer camera state.") {
    super(message);
    this.name = "StaleRequestError";
  }
}

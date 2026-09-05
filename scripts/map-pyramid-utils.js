export function selectLod(effectiveScale, previousTier = null, forcedMode = "auto") {
  if (!forcedMode) forcedMode = "auto";
  if (["z0", "z1", "z2"].includes(forcedMode)) return forcedMode;
  if (forcedMode !== "auto") throw new Error(`Unknown LOD mode: ${forcedMode}`);

  if (previousTier === "z2" && effectiveScale >= 0.765) return "z2";
  if (previousTier === "z1") {
    if (effectiveScale >= 0.9) return "z2";
    if (effectiveScale >= 0.3825) return "z1";
  }
  if (previousTier === "z0" && effectiveScale < 0.45) return "z0";
  if (effectiveScale >= 0.9) return "z2";
  if (effectiveScale >= 0.45) return "z1";
  return "z0";
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

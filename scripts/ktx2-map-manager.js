import {
  ByteLruCache,
  canvasRectToSceneRect,
  orderedVisibleLevelIds,
  performanceLoadConcurrency,
  PriorityLoadQueue,
  QueueCancelledError,
  resolveDisplaySlot,
  resolveNativeLevelId,
  scenePointToCanvasPoint,
  selectLod,
  selectTileDemand,
  selectVisibleTiles,
  retryDelay,
  validateAscendingTierDensities,
  validateManifestTileEntry
} from "./map-pyramid-utils.js";

const MODULE_ID = "theiks-ktx2-renderer";
const SETTING_LOD = "mapLod";
const CACHE_BYTES = 384 * 1024 * 1024;
const RELEASE_DELAY_MS = 60_000;
const PRIORITY = Object.freeze({
  FALLBACK: 0,
  ACTIVE_VISIBLE: 1,
  RELATED_VISIBLE: 2,
  ACTIVE_PREFETCH: 3,
  RELATED_PREFETCH: 4
});

class Ktx2LevelContainer extends foundry.canvas.primary.PrimaryCanvasContainer {
  constructor(level) {
    super();
    this.levelId = level.id;
    this.name = `ktx2-pyramid-${level.id}`;
    this.eventMode = "none";
    this.elevation = Number(level.elevation?.bottom ?? 0);
    this.sort = 0;
    this.sortLayer = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.SCENE;
  }
}

export class Ktx2MapManager extends foundry.canvas.SceneManager {
  static manifestCache = new Map();

  manifest = null;
  manifestUrl = null;
  containers = new Map();
  records = new Map();
  slots = new Map();
  pendingLoads = new Map();
  failures = new Map();
  unloadingPaths = new Map();
  nativeStates = new Map();
  demand = new Map();
  activeTier = null;
  activeLevelId = null;
  visibleLevelIds = new Set();
  warningShown = false;
  viewScale = 1;
  frameHandle = null;
  releaseTimer = null;
  retryTimer = null;
  retryAt = 0;
  fatalState = false;
  destroyed = false;

  constructor(scene) {
    super(scene);
    this.cache = new ByteLruCache(CACHE_BYTES);
    this.queue = new PriorityLoadQueue(this.#loadConcurrency());
  }

  async _onInit() {
    try {
      const flag = this.scene.getFlag(MODULE_ID, "mapPyramid");
      if (!flag || typeof flag !== "object") throw new Error("the mapPyramid flag is missing.");
      if (!flag.manifest) throw new Error("the mapPyramid flag has no manifest path.");
      this.manifestUrl = flag.manifest;
      this.manifest = await this.#loadManifest(flag.manifest);
      this.#validateManifest();
    } catch (error) {
      this.#notifyIncompatible(error);
      throw error;
    }
  }

  async _onDraw() {
    for (const manifestLevel of this.manifest.levels) {
      const level = this.scene.levels.get(manifestLevel.id);
      if (!level) throw new Error(`Map pyramid references missing Level ${manifestLevel.id}.`);
      const container = new Ktx2LevelContainer(level);
      container.visible = false;
      canvas.primary.addChild(container);
      this.containers.set(level.id, container);
    }
    canvas.primary.sortChildren();
    await this.#preloadInitialView();
  }

  async _onReady() {
    const fromStage = Number(canvas.stage?.scale?.x);
    if (Number.isFinite(fromStage) && fromStage > 0) this.viewScale = fromStage;
    this.#captureNativeLevelMeshes();
    this.#reconcile();
  }

  _registerHooks() {
    this.registerHook("canvasPan", (activeCanvas, position) => {
      if (activeCanvas !== canvas) return;
      const scale = Number(position?.scale);
      if (Number.isFinite(scale) && scale > 0) this.viewScale = scale;
      this.requestRefresh();
    });
    this.registerHook("updateScene", document => {
      if (document.id === this.scene.id) this.requestRefresh();
    });
    this.registerHook("updateLevel", document => {
      if (document.parent?.id === this.scene.id) this.requestRefresh();
    });
  }

  async _onTearDown() {
    this.destroyed = true;
    this.#cancelFrame();
    clearTimeout(this.releaseTimer);
    clearTimeout(this.retryTimer);
    this.queue.cancelWhere(() => true);
    this.#restoreAllNativeMeshes();
    for (const slot of this.slots.values()) this.#destroySlot(slot);
    this.slots.clear();
    await Promise.allSettled([...this.pendingLoads.values()].map(entry => entry.promise));
    for (const record of this.records.values()) this.#destroyRecord(record);
    this.records.clear();
    this.cache.clear();
    this.demand.clear();
    this.visibleLevelIds.clear();
    for (const container of this.containers.values()) container.destroy({children: true});
    this.containers.clear();
    await Promise.allSettled(this.unloadingPaths.values());
  }

  requestRefresh() {
    if (this.destroyed || this.frameHandle != null) return;
    const schedule = globalThis.requestAnimationFrame ?? (callback => setTimeout(callback, 0));
    this.frameHandle = schedule(() => {
      this.frameHandle = null;
      try {
        this.#reconcile();
      } catch (error) {
        this.#fatal(error);
      }
    });
  }

  getStats() {
    const failedTiles = [...this.failures.keys()].filter(key => this.demand.has(key)).length;
    const prefetchedTiles = [...this.demand.values()].filter(entry => entry.prefetch).length;
    return {
      sceneId: this.scene.id,
      activeLevelId: this.activeLevelId,
      activeTier: this.activeTier,
      loadedTextures: this.records.size,
      pendingTextures: this.pendingLoads.size,
      estimatedCacheBytes: this.cache.totalBytes,
      cacheBudgetBytes: this.cache.maximumBytes,
      queuedTiles: this.queue.queuedCount,
      inFlightTiles: this.queue.inFlightCount,
      failedTiles,
      visibleSlots: this.slots.size,
      prefetchedTiles,
      queuedTextures: this.queue.queuedCount,
      inFlightTextures: this.queue.inFlightCount,
      failedTextures: failedTiles,
      visibleSlotCount: this.slots.size,
      prefetchedTextures: prefetchedTiles
    };
  }

  async #loadManifest(url) {
    let promise = Ktx2MapManager.manifestCache.get(url);
    if (!promise) {
      promise = fetch(url).then(response => {
        if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}.`);
        return response.json();
      });
      Ktx2MapManager.manifestCache.set(url, promise);
    }
    try {
      return await promise;
    } catch (error) {
      Ktx2MapManager.manifestCache.delete(url);
      throw error;
    }
  }

  #validateManifest() {
    const manifest = this.manifest;
    if (!manifest || typeof manifest !== "object") throw new Error("the pyramid manifest is not an object.");
    if (manifest.schemaVersion !== 1) throw new Error(`unsupported pyramid schema ${manifest.schemaVersion}.`);
    if (!Array.isArray(manifest.levels) || !manifest.levels.length) throw new Error("the pyramid manifest has no levels.");
    if (!manifest.scene || typeof manifest.scene !== "object") throw new Error("the pyramid manifest has no scene size.");
    if (manifest.scene.width !== this.scene.width || manifest.scene.height !== this.scene.height) {
      throw new Error("Map pyramid dimensions do not match the Scene.");
    }
    if (manifest.scene.gridSize !== this.scene.grid.size) throw new Error("Map pyramid grid size does not match the Scene.");

    let referenceTiers;
    for (const level of manifest.levels) {
      if (!level?.id || !Array.isArray(level.tiers) || !level.tiers.length) {
        throw new Error(`level ${level?.id ?? "(missing id)"} has no tile tiers.`);
      }
      const tierShape = [];
      for (const tier of level.tiers) {
        if (!tier?.id || !Array.isArray(tier.tiles) || !tier.tiles.length) {
          throw new Error(`${level.name ?? level.id} ${tier?.id ?? "tier"} has no tiles.`);
        }
        const density = Number(tier.density ?? (tier.gridPixels / manifest.scene.gridSize));
        tier.density = density;
        tierShape.push(`${tier.id}:${density}`);
        for (const tile of tier.tiles) validateManifestTileEntry(tile);
      }
      validateAscendingTierDensities(level.tiers, manifest.scene.gridSize);
      if (!referenceTiers) referenceTiers = tierShape;
      else if (referenceTiers.join("|") !== tierShape.join("|")) {
        throw new Error(`${level.name ?? level.id} does not use the same tier ladder as the other floors.`);
      }
      if (level.tiers[0].tiles.some(tile => tile.blank)) {
        throw new Error(`${level.name ?? level.id} has a blank least-density fallback tile.`);
      }
    }
  }

  async #preloadInitialView() {
    const levelIds = this.#visibleLevels();
    if (!levelIds.length) return;
    const rootLoads = [];
    for (const levelId of levelIds) {
      const level = this.#level(levelId);
      const tier = level?.tiers[0];
      if (!tier) continue;
      for (const tile of tier.tiles) rootLoads.push(this.#requestTile(level, tier, tile, PRIORITY.FALLBACK, true));
    }
    await Promise.all(rootLoads);

    const activeId = canvas.level?.id;
    const activeLevel = this.#level(activeId);
    const viewport = this.#safeViewport();
    if (!activeLevel || !viewport) return;
    const tierId = selectLod(this.#effectiveScale(), null, this.#lodSetting(), activeLevel.tiers);
    const tier = this.#tier(activeLevel, tierId);
    if (tier === activeLevel.tiers[0]) return;
    const margin = 0.5 * this.#largestTileDimension(tier);
    const detail = selectVisibleTiles(tier.tiles, viewport, margin).filter(tile => !tile.blank);
    await Promise.allSettled(detail.map(tile => this.#requestTile(activeLevel, tier, tile, PRIORITY.ACTIVE_VISIBLE, false)));
  }

  #reconcile() {
    if (this.destroyed || this.fatalState || !canvas.ready || canvas.scene?.id !== this.scene.id) return;
    const activeId = canvas.level?.id;
    const activeLevel = this.#level(activeId);
    if (!activeLevel) return;
    const viewport = this.#viewport();
    const visibleIds = this.#visibleLevels();
    const visibleSet = new Set(visibleIds);
    const requestedTier = selectLod(
      this.#effectiveScale(),
      this.activeLevelId === activeId ? this.activeTier : null,
      this.#lodSetting(),
      activeLevel.tiers
    );
    this.queue.setConcurrency(this.#loadConcurrency());

    const nextDemand = new Map();
    const display = new Map();
    for (const levelId of visibleIds) {
      const level = this.#level(levelId);
      if (!level) continue;
      const root = level.tiers[0];
      for (const tile of root.tiles) this.#addDemand(nextDemand, level, root, tile, PRIORITY.FALLBACK, false, true);

      const tier = this.#tier(level, requestedTier);
      const margin = 0.25 * this.#largestTileDimension(tier);
      const selected = selectTileDemand(tier.tiles, viewport, margin);
      display.set(levelId, {level, tier, visible: selected.visible});
      if (tier !== root) {
        const active = levelId === activeId;
        for (const tile of selected.visible) {
          this.#addDemand(nextDemand, level, tier, tile, active ? PRIORITY.ACTIVE_VISIBLE : PRIORITY.RELATED_VISIBLE, false, false);
        }
        for (const tile of selected.prefetched) {
          this.#addDemand(nextDemand, level, tier, tile, active ? PRIORITY.ACTIVE_PREFETCH : PRIORITY.RELATED_PREFETCH, true, false);
        }
      }
    }

    this.demand = nextDemand;
    this.activeLevelId = activeId;
    this.activeTier = requestedTier;
    this.visibleLevelIds = visibleSet;
    this.queue.cancelWhere(entry => !nextDemand.has(entry.key));

    for (const [levelId, container] of this.containers) {
      container.visible = visibleSet.has(levelId);
      if (!container.visible) this.#restoreNativeMesh(levelId);
    }
    for (const {level, tier, visible} of display.values()) this.#syncLevelSlots(level, tier, visible);
    for (const [key, slot] of this.slots) {
      const state = display.get(slot.levelId);
      if (!visibleSet.has(slot.levelId) || state?.tier.id !== slot.tierId || !state.visible.some(tile => tile.id === slot.tileId)) {
        this.#destroySlot(slot);
        this.slots.delete(key);
      }
    }
    for (const {level, tier, visible} of display.values()) {
      const covered = this.#visibleAreaCovered(level.id, tier, visible);
      if (covered) this.#hideNativeMesh(level.id);
      else this.#restoreNativeMesh(level.id);
      const container = this.containers.get(level.id);
      if (container) container.visible = covered || !this.nativeStates.has(level.id);
    }

    for (const entry of [...nextDemand.values()].sort((left, right) => left.priority - right.priority)) {
      if (entry.tile.blank || this.records.has(entry.key)) continue;
      const failure = this.failures.get(entry.key);
      if (failure && failure.nextRetry > Date.now()) {
        this.#scheduleRetry(failure.nextRetry);
        continue;
      }
      void this.#requestTile(entry.level, entry.tier, entry.tile, entry.priority, entry.fallback)
        .catch(error => {
          if (error instanceof QueueCancelledError) return;
          if (entry.fallback) this.#fatal(error);
        });
    }
    this.#finishReconcile();
    canvas.primary.renderDirty = true;
  }

  #syncLevelSlots(level, tier, visibleTiles) {
    for (const [key, slot] of this.slots) {
      if (slot.levelId === level.id && slot.tierId !== tier.id) {
        this.#destroySlot(slot);
        this.slots.delete(key);
      }
    }
    for (const tile of visibleTiles) {
      const key = this.#slotKey(level.id, tier.id, tile.id);
      if (tile.blank) {
        const existing = this.slots.get(key);
        if (existing) this.#destroySlot(existing);
        this.slots.delete(key);
        continue;
      }
      const selection = resolveDisplaySlot(level.id, level.tiers, tier.id, tile, new Set(this.records.keys()));
      if (selection.mode === "uncovered") continue;
      const target = selection.mode === "target";
      const pieces = selection.pieces.map(piece => ({...piece, record: piece.key ? this.records.get(piece.key) : null}));
      const signature = pieces.map(piece => piece.record
        ? `${piece.record.key}:${piece.frame.x},${piece.frame.y},${piece.frame.width},${piece.frame.height}`
        : `blank:${piece.scene.x},${piece.scene.y},${piece.scene.width},${piece.scene.height}`).join("|");
      const existing = this.slots.get(key);
      if (existing?.signature === signature) continue;
      if (existing) this.#destroySlot(existing);
      this.slots.set(key, this.#createSlot(level.id, tier.id, tile.id, pieces, signature, target));
    }
  }

  #createSlot(levelId, tierId, tileId, pieces, signature, target) {
    const slot = {levelId, tierId, tileId, signature, target, covered: true, meshes: [], sourceKeys: new Set()};
    for (const piece of pieces) {
      if (!piece.record) continue;
      slot.sourceKeys.add(piece.record.key);
      const framed = this.#frameTexture(piece.record.texture, piece.frame);
      const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
        name: `ktx2.${levelId}.${tierId}.${tileId}`,
        texture: framed
      });
      mesh.anchor.set(0, 0);
      const position = scenePointToCanvasPoint(piece.scene, canvas.dimensions.sceneRect);
      mesh.position.set(position.x, position.y);
      mesh.width = piece.scene.width;
      mesh.height = piece.scene.height;
      mesh.eventMode = "none";
      this.#configureBackgroundMesh(mesh, levelId);
      this.containers.get(levelId).addChild(mesh);
      slot.meshes.push({mesh, framed, source: piece.record.texture});
    }
    return slot;
  }

  #destroySlot(slot) {
    for (const piece of slot.meshes) {
      if (piece.mesh.parent) piece.mesh.parent.removeChild(piece.mesh);
      piece.mesh.destroy({children: true, texture: false, textureSource: false});
      if (piece.framed !== piece.source) piece.framed.destroy(false);
    }
    slot.meshes.length = 0;
    slot.sourceKeys.clear();
  }

  #visibleAreaCovered(levelId, tier, visibleTiles) {
    return visibleTiles.every(tile => tile.blank || this.slots.get(this.#slotKey(levelId, tier.id, tile.id))?.covered);
  }

  #addDemand(target, level, tier, tile, priority, prefetch, fallback) {
    if (tile.blank) return;
    const key = this.#tileKey(level.id, tier.id, tile.id);
    const existing = target.get(key);
    if (existing && existing.priority <= priority) return;
    target.set(key, {key, level, tier, tile, priority, prefetch, fallback});
  }

  #requestTile(level, tier, tile, priority, fatal) {
    if (tile.blank) return Promise.resolve(null);
    const key = this.#tileKey(level.id, tier.id, tile.id);
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return Promise.resolve(cached);
    }
    const pending = this.pendingLoads.get(key);
    if (pending) {
      this.queue.setPriority(key, priority);
      return pending.promise;
    }
    const failure = this.failures.get(key);
    if (failure && failure.nextRetry > Date.now()) {
      this.#scheduleRetry(failure.nextRetry);
      return Promise.reject(failure.error);
    }

    const entry = {promise: null};
    const queued = this.queue.enqueue(key, priority, async () => {
      await this.#waitForAssetUnload(tile.path);
      const texture = await foundry.canvas.loadTexture(tile.path);
      if (!texture) throw new Error(`Foundry returned no texture for ${tile.path}.`);
      if (this.destroyed) {
        texture.destroy(false);
        throw new QueueCancelledError(`Discarded ${tile.path} after Scene teardown.`);
      }
      const record = {
        key,
        levelId: level.id,
        tierId: tier.id,
        tileId: tile.id,
        path: tile.path,
        texture,
        bytes: tile.pixel.width * tile.pixel.height * 4,
        lastUsed: Date.now()
      };
      this.records.set(key, record);
      this.failures.delete(key);
      const evicted = this.cache.set(key, record, record.bytes, this.#pinnedKeys());
      for (const [evictedKey, evictedRecord] of evicted) this.#destroyRecord(evictedRecord, evictedKey);
      this.requestRefresh();
      return record;
    });
    if (!queued) return Promise.resolve(this.records.get(key) ?? null);
    entry.promise = queued.catch(error => {
      if (error instanceof QueueCancelledError || this.destroyed) throw error;
      this.#recordFailure(key, tile.path, error, fatal);
      throw error;
    }).finally(() => {
      if (this.pendingLoads.get(key) === entry) this.pendingLoads.delete(key);
    });
    this.pendingLoads.set(key, entry);
    return entry.promise;
  }

  #recordFailure(key, path, error, fatal) {
    console.error(`${MODULE_ID} | Could not load map tile ${path}.`, error);
    if (fatal) return;
    const previous = this.failures.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = retryDelay(attempts);
    const nextRetry = Date.now() + delay;
    this.failures.set(key, {attempts, nextRetry, error});
    if (this.demand.has(key)) this.#scheduleRetry(nextRetry);
    if (!this.warningShown && game.user?.isGM) {
      ui.notifications.warn(`Some detailed map tiles failed to load on ${this.#sceneLabel()}. Lower-detail coverage will remain visible while the renderer retries.`);
      this.warningShown = true;
    }
  }

  #scheduleRetry(at) {
    if (this.destroyed || (this.retryTimer && this.retryAt <= at)) return;
    clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = 0;
      this.requestRefresh();
    }, Math.max(0, at - Date.now()));
  }

  #finishReconcile() {
    const pinned = this.#pinnedKeys();
    const now = Date.now();
    for (const key of pinned) {
      const record = this.records.get(key);
      if (record) record.lastUsed = now;
    }
    for (const [key, record] of this.cache.evict(pinned)) this.#destroyRecord(record, key);
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.#releaseOffscreen(), RELEASE_DELAY_MS);
  }

  #releaseOffscreen() {
    if (this.destroyed) return;
    const pinned = this.#pinnedKeys();
    const cutoff = Date.now() - RELEASE_DELAY_MS;
    for (const [key, record] of this.records) {
      if (pinned.has(key) || record.lastUsed > cutoff) continue;
      this.cache.delete(key);
      this.#destroyRecord(record, key);
    }
    canvas.primary.renderDirty = true;
  }

  #pinnedKeys() {
    const pinned = new Set(this.demand.keys());
    for (const slot of this.slots.values()) {
      for (const key of slot.sourceKeys) pinned.add(key);
    }
    return pinned;
  }

  #loadConcurrency() {
    try {
      return performanceLoadConcurrency(game.settings.get("core", "performanceMode"));
    } catch {
      return 2;
    }
  }

  #visibleLevels() {
    const active = canvas.level;
    if (!active) return [];
    return orderedVisibleLevelIds(this.scene.levels, active.id);
  }

  #level(levelId) {
    return this.manifest.levels.find(level => level.id === levelId);
  }

  #tier(level, tierId) {
    const tier = level?.tiers.find(candidate => candidate.id === tierId);
    if (!tier) throw new Error(`${level?.name ?? "Map level"} does not define ${tierId}.`);
    return tier;
  }

  #largestTileDimension(tier) {
    return Math.max(...tier.tiles.map(tile => Math.max(tile.scene.width, tile.scene.height)));
  }

  #lodSetting() {
    try {
      return game.settings.get(MODULE_ID, SETTING_LOD) || "auto";
    } catch {
      return "auto";
    }
  }

  #effectiveScale() {
    const fromStage = Number(canvas.stage?.scale?.x);
    const scale = Number.isFinite(fromStage) && fromStage > 0 ? fromStage : this.viewScale;
    const resolution = Number(canvas.app?.renderer?.resolution ?? 1) || 1;
    return scale * resolution;
  }

  #safeViewport() {
    try {
      return this.#viewport();
    } catch {
      return null;
    }
  }

  #viewport() {
    const renderer = canvas.app.renderer;
    const topLeft = canvas.canvasCoordinatesFromClient({x: 0, y: 0});
    const bottomRight = canvas.canvasCoordinatesFromClient({x: renderer.screen.width, y: renderer.screen.height});
    const x = Math.min(topLeft.x, bottomRight.x);
    const y = Math.min(topLeft.y, bottomRight.y);
    return canvasRectToSceneRect({
      x,
      y,
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y)
    }, canvas.dimensions.sceneRect);
  }

  #tileKey(levelId, tierId, tileId) {
    return `${levelId}/${tierId}/${tileId}`;
  }

  #slotKey(levelId, tierId, tileId) {
    return `${levelId}/${tierId}/${tileId}`;
  }

  #captureNativeLevelMeshes() {
    const meshes = [...(canvas.primary.levelTextures ?? [])];
    const levels = [...this.scene.levels];
    for (const mesh of meshes) {
      const levelId = resolveNativeLevelId(mesh, levels);
      if (!levelId) continue;
      this.nativeStates.set(levelId, {
        mesh,
        alpha: mesh.alpha,
        visible: mesh.visible,
        renderable: mesh.renderable,
        parent: mesh.parent,
        restrictsLight: mesh.restrictsLight,
        restrictsWeather: mesh.restrictsWeather
      });
    }
  }

  #hideNativeMesh(levelId) {
    const state = this.nativeStates.get(levelId);
    if (!state) return false;
    const mesh = state.mesh;
    if (mesh.parent) {
      state.parent = mesh.parent;
      mesh.parent.removeChild(mesh);
    }
    mesh.visible = true;
    mesh.renderable = true;
    mesh.alpha = state.alpha || 1;
    mesh.restrictsLight = false;
    mesh.restrictsWeather = false;
    this.#pointPrimaryBackgroundAtViewedLevel();
    return true;
  }

  #restoreNativeMesh(levelId) {
    const state = this.nativeStates.get(levelId);
    if (!state) return;
    const mesh = state.mesh;
    mesh.alpha = state.alpha;
    mesh.visible = state.visible;
    mesh.renderable = state.renderable;
    mesh.restrictsLight = state.restrictsLight;
    mesh.restrictsWeather = state.restrictsWeather;
    if (state.parent && mesh.parent !== state.parent) state.parent.addChild(mesh);
  }

  #restoreAllNativeMeshes() {
    for (const levelId of this.nativeStates.keys()) this.#restoreNativeMesh(levelId);
  }

  #pointPrimaryBackgroundAtViewedLevel() {
    const viewedId = canvas.level?.id;
    const mesh = viewedId ? this.nativeStates.get(viewedId)?.mesh : null;
    if (!mesh || !canvas.primary) return;
    Object.defineProperty(canvas.primary, "background", {value: mesh, configurable: true});
  }

  #configureBackgroundMesh(mesh, levelId) {
    const sceneLevel = this.scene.levels.get(levelId);
    mesh.textureAlphaThreshold = Number(sceneLevel?.background?.alphaThreshold ?? 0.75);
    mesh.restrictsLight = true;
    mesh.restrictsWeather = true;
    mesh.occlusionMode = CONST.OCCLUSION_MODES.SURFACE;
    mesh.sort = 0;
    mesh.sortLayer = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.SCENE;
  }

  #frameTexture(texture, frame) {
    if (frame.x === 0 && frame.y === 0 && frame.width === texture.width && frame.height === texture.height) return texture;
    const rectangle = new PIXI.Rectangle(frame.x, frame.y, frame.width, frame.height);
    if (texture.source) return new PIXI.Texture({source: texture.source, frame: rectangle});
    return new PIXI.Texture(texture.baseTexture, rectangle);
  }

  #destroyRecord(record, key = record?.key) {
    if (!record) return;
    if (key) this.records.delete(key);
    record.texture?.destroy(false);
    if (record.tierId !== this.#level(record.levelId)?.tiers[0]?.id) void this.#unloadAsset(record.path);
  }

  async #waitForAssetUnload(path) {
    const pending = this.unloadingPaths.get(path);
    if (pending) await pending;
  }

  #unloadAsset(path) {
    if (!path) return Promise.resolve();
    const current = this.unloadingPaths.get(path);
    if (current) return current;
    const cacheBustPath = foundry.utils.getCacheBustURL(path);
    const cacheKey = PIXI.Assets.cache.has(path) ? path
      : cacheBustPath && PIXI.Assets.cache.has(cacheBustPath) ? cacheBustPath
        : path;
    const pending = PIXI.Assets.unload(cacheKey)
      .catch(error => console.warn(`${MODULE_ID} | Could not unload ${path}`, error))
      .finally(() => {
        if (this.unloadingPaths.get(path) === pending) this.unloadingPaths.delete(path);
      });
    this.unloadingPaths.set(path, pending);
    return pending;
  }

  #cancelFrame() {
    if (this.frameHandle == null) return;
    const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
    cancel(this.frameHandle);
    this.frameHandle = null;
  }

  #sceneLabel() {
    return this.scene?.name || this.scene?.id || "this Scene";
  }

  #incompatibleMessage(error) {
    const detail = error?.message ? ` ${error.message.replace(/^[A-Z]/, match => match.toLowerCase())}` : "";
    return `${this.#sceneLabel()} needs a newer Theik's KTX2 Renderer (or the map module is newer than this renderer).${detail}`;
  }

  #notifyIncompatible(error) {
    console.error(`${MODULE_ID} | ${this.#sceneLabel()} KTX2 pyramid cannot be displayed.`, error);
    if (game.user?.isGM) ui.notifications.error(this.#incompatibleMessage(error), {permanent: true});
  }

  #fatal(error) {
    if (this.destroyed || this.fatalState) return;
    this.fatalState = true;
    console.error(`${MODULE_ID} | Required map fallback failed.`, error);
    this.queue.cancelWhere(() => true);
    this.#restoreAllNativeMeshes();
    for (const container of this.containers.values()) container.visible = false;
    this.visibleLevelIds.clear();
    if (game.user?.isGM) ui.notifications.error(`Required map coverage failed on ${this.#sceneLabel()}. Foundry restored the native backgrounds.`, {permanent: true});
  }
}

function pyramidFlag(scene) {
  return scene?.flags?.[MODULE_ID]?.mapPyramid ?? scene?.getFlag?.(MODULE_ID, "mapPyramid");
}

function registerScene(scene) {
  if (!scene) return;
  const flag = pyramidFlag(scene);
  if (flag != null) CONFIG.Canvas.managedScenes[scene.id] = Ktx2MapManager;
  else if (CONFIG.Canvas.managedScenes[scene.id] === Ktx2MapManager) delete CONFIG.Canvas.managedScenes[scene.id];
}

function warnIfPyramidDidNotAttach(scene) {
  if (!scene || !game.user?.isGM) return;
  const flag = pyramidFlag(scene);
  const hasKtx2Background = [...(scene.levels ?? [])].some(level => String(level.background?.src ?? "").includes(".ktx2"));
  const attached = canvas.manager instanceof Ktx2MapManager;
  if (flag && !attached) {
    ui.notifications.error(`${scene.name || scene.id} has a KTX2 pyramid flag, but Theik's KTX2 Renderer did not attach. Reload the Scene after enabling the renderer.`);
    return;
  }
  if (!flag && hasKtx2Background) {
    ui.notifications.error(`${scene.name || scene.id} uses KTX2 level backgrounds but has no flags.theiks-ktx2-renderer.mapPyramid flag, so high-resolution zoom streaming is off.`);
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_LOD, {
    name: "Map detail",
    hint: "Choose automatic zoom-based map detail or force a semantic detail level for this browser.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "Auto",
      z0: "Low",
      z1: "Medium",
      z2: "High"
    },
    default: "auto",
    onChange: () => canvas.manager instanceof Ktx2MapManager && canvas.manager.requestRefresh()
  });
  for (const scene of game.scenes ?? []) registerScene(scene);
});

Hooks.once("setup", () => {
  for (const scene of game.scenes) registerScene(scene);
});

Hooks.on("createScene", registerScene);
Hooks.on("updateScene", scene => registerScene(scene));
Hooks.on("canvasInit", () => registerScene(canvas.scene));
Hooks.on("canvasReady", () => warnIfPyramidDidNotAttach(canvas.scene));

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    getMapStreamingStats: () => canvas.manager instanceof Ktx2MapManager ? canvas.manager.getStats() : null
  };
});

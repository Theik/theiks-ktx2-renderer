import {
  ByteLruCache,
  canvasRectToSceneRect,
  RequestGeneration,
  resolveNativeLevelId,
  scenePointToCanvasPoint,
  selectLod,
  selectVisibleTiles,
  StaleRequestError,
  orderedVisibleLevelIds
} from "./map-pyramid-utils.js";

const MODULE_ID = "theiks-ktx2-renderer";
const SETTING_LOD = "mapLod";
const CACHE_BYTES = 384 * 1024 * 1024;
const PAN_DEBOUNCE_MS = 250;
const RELEASE_DELAY_MS = 60000;
const LOAD_CONCURRENCY = 1;
const ACTIVE_HD_QUEUE_PRIORITY = 2;
const RELATED_HD_QUEUE_PRIORITY = 1;
const FALLBACK_QUEUE_PRIORITY = 0;

class LoadQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.active = 0;
    this.pending = [];
  }

  add(task, priority = 0) {
    return new Promise((resolve, reject) => {
      this.pending.push({task, resolve, reject, priority});
      this.pending.sort((left, right) => right.priority - left.priority);
      this.#drain();
    });
  }

  clear(error = new StaleRequestError()) {
    for (const item of this.pending.splice(0)) item.reject(error);
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.#drain();
        });
    }
  }
}

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
  pendingLoads = new Map();
  unloadingPaths = new Map();
  nativeStates = new Map();
  displayedTiers = new Map();
  activeTier = null;
  activeLevelId = null;
  warningShown = false;
  viewScale = 1;
  refreshTimer = null;
  releaseTimer = null;
  refreshing = false;
  refreshQueued = false;
  destroyed = false;

  constructor(scene) {
    super(scene);
    this.cache = new ByteLruCache(CACHE_BYTES);
    this.generations = new RequestGeneration();
    this.queue = new LoadQueue(LOAD_CONCURRENCY);
  }

  async _onInit() {
    try {
      const flag = this.scene.getFlag(MODULE_ID, "mapPyramid");
      if (!flag || typeof flag !== "object") {
        throw new Error("the mapPyramid flag is missing.");
      }
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
  }

  async _onReady() {
    const fromStage = Number(canvas.stage?.scale?.x);
    if (Number.isFinite(fromStage) && fromStage > 0) this.viewScale = fromStage;
    this.#captureNativeLevelMeshes();
    this.refreshing = true;
    try {
      await this.#refresh();
    } finally {
      this.refreshing = false;
    }
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
  }

  async _onTearDown() {
    this.destroyed = true;
    this.generations.next();
    this.refreshQueued = false;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.releaseTimer);
    this.queue.clear();
    this.#restoreAllNativeMeshes();
    for (const record of this.records.values()) this.#destroyRecord(record);
    this.records.clear();
    this.cache.clear();
    this.displayedTiers.clear();
    for (const container of this.containers.values()) container.destroy({children: true});
    this.containers.clear();
    await Promise.allSettled(this.unloadingPaths.values());
  }

  requestRefresh() {
    if (this.destroyed) return;
    if (this.refreshing) {
      this.generations.next();
      this.queue.clear();
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.#beginRefresh(), PAN_DEBOUNCE_MS);
  }

  #beginRefresh() {
    if (this.destroyed) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshQueued = false;
    this.refreshing = true;
    this.#refresh()
      .catch(error => {
        if (!(error instanceof StaleRequestError)) this.#warnAndRestore(error);
      })
      .finally(() => {
        this.refreshing = false;
        if (this.refreshQueued && !this.destroyed) this.#beginRefresh();
      });
  }

  getStats() {
    return {
      sceneId: this.scene.id,
      activeLevelId: this.activeLevelId,
      activeTier: this.activeTier,
      loadedTextures: this.records.size,
      pendingTextures: this.pendingLoads.size,
      estimatedCacheBytes: this.cache.totalBytes,
      cacheBudgetBytes: this.cache.maximumBytes
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
    if (!Array.isArray(manifest.levels) || !manifest.levels.length) {
      throw new Error("the pyramid manifest has no levels.");
    }
    if (!manifest.scene || typeof manifest.scene !== "object") throw new Error("the pyramid manifest has no scene size.");
    if (manifest.scene.width !== this.scene.width || manifest.scene.height !== this.scene.height) {
      throw new Error("Map pyramid dimensions do not match the Scene.");
    }
    if (manifest.scene.gridSize !== this.scene.grid.size) throw new Error("Map pyramid grid size does not match the Scene.");
    for (const level of manifest.levels) {
      if (!level?.id || !Array.isArray(level.tiers) || !level.tiers.length) {
        throw new Error(`level ${level?.id ?? "(missing id)"} has no tile tiers.`);
      }
      for (const tier of level.tiers) {
        if (!tier?.id || !Array.isArray(tier.tiles) || !tier.tiles.length) {
          throw new Error(`${level.name ?? level.id} ${tier?.id ?? "tier"} has no tiles.`);
        }
        for (const tile of tier.tiles) {
          if (!tile?.id || !tile.path || !tile.scene || !tile.pixel || !tile.frame) {
            throw new Error(`${level.name ?? level.id} ${tier.id} has a tile the renderer cannot read.`);
          }
        }
      }
    }
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
    if (!state) {
      console.warn(`${MODULE_ID} | Could not identify the native background mesh for Level ${levelId}; leaving native rendering unchanged.`);
      return false;
    }
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

  #pointPrimaryBackgroundAtViewedLevel() {
    const viewedId = canvas.level?.id;
    const mesh = viewedId ? this.nativeStates.get(viewedId)?.mesh : null;
    if (!mesh || !canvas.primary) return;
    Object.defineProperty(canvas.primary, "background", {value: mesh, configurable: true});
  }

  #restoreAllNativeMeshes() {
    for (const levelId of this.nativeStates.keys()) this.#restoreNativeMesh(levelId);
  }

  #visibleLevelIds() {
    const active = canvas.level;
    if (!active) return [];
    return orderedVisibleLevelIds(this.scene.levels, active.id);
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

  #tier(level, tierId) {
    const tier = level.tiers.find(candidate => candidate.id === tierId);
    if (!tier) throw new Error(`${level.name} does not define ${tierId}.`);
    return tier;
  }

  #tileKey(levelId, tierId, tileId) {
    return `${levelId}/${tierId}/${tileId}`;
  }

  #setLevelDisplay(levelId, tierId, {includeLow = false} = {}) {
    for (const record of this.records.values()) {
      if (record.levelId === levelId) record.mesh.visible = record.tierId === tierId || (includeLow && record.tierId === "z0");
    }
  }

  #hasTiles(levelId, tierId, tiles) {
    return tiles.every(tile => this.records.has(this.#tileKey(levelId, tierId, tile.id)));
  }

  #isCurrentViewReady(activeId, requestedTier, pinned) {
    if (this.activeLevelId !== activeId || this.activeTier !== requestedTier) return false;
    if ((this.displayedTiers.get(activeId) ?? "z0") !== requestedTier) return false;
    const activePrefix = `${activeId}/`;
    for (const key of pinned) {
      if (key.startsWith(activePrefix) && !this.records.has(key)) return false;
    }
    return true;
  }

  async #refresh() {
    if (this.destroyed || !canvas.ready || canvas.scene?.id !== this.scene.id) return;
    const active = canvas.level;
    if (!active) return;
    const visibleLevelIds = this.#visibleLevelIds();
    const visibleSet = new Set(visibleLevelIds);
    const viewport = this.#viewport();
    const requestedTier = selectLod(
      this.#effectiveScale(),
      this.activeLevelId === active.id ? this.activeTier : null,
      this.#lodSetting()
    );
    const pinned = new Set();
    const relatedLevelIds = visibleLevelIds.filter(levelId => levelId !== active.id);

    this.#pinLevelFallback(active.id, pinned);
    if (requestedTier !== "z0") this.#pinVisibleTiles(active.id, requestedTier, viewport, pinned);
    for (const levelId of relatedLevelIds) {
      this.#pinLevelFallback(levelId, pinned);
      if (requestedTier !== "z0") this.#pinVisibleTiles(levelId, requestedTier, viewport, pinned);
    }
    if (this.#isCurrentViewReady(active.id, requestedTier, pinned)) return;

    const generation = this.generations.next();

    for (const [levelId, container] of this.containers) {
      if (levelId === active.id) {
        container.visible = true;
        this.#hideNativeMesh(levelId);
        continue;
      }
      if (!visibleSet.has(levelId)) {
        container.visible = false;
        this.#restoreNativeMesh(levelId);
        continue;
      }
      const nearerIds = relatedLevelIds.slice(0, relatedLevelIds.indexOf(levelId));
      const nearerShowing = nearerIds.every(id => this.containers.get(id)?.visible);
      if (!nearerShowing) container.visible = false;
      this.#hideNativeMesh(levelId);
    }
    const activeLevel = this.manifest.levels.find(level => level.id === active.id);
    if (!activeLevel) return;
    await this.#ensureLevelFallback(active.id, pinned, generation);
    if (!this.generations.isCurrent(generation)) return;
    this.#hideNativeMesh(active.id);

    if (requestedTier === "z0") {
      this.#showLevelTier(active.id, "z0");
      this.activeLevelId = active.id;
      this.activeTier = "z0";
      this.#finishRefresh(pinned);
      this.#loadRelatedLevels(relatedLevelIds, "z0", viewport, pinned, generation);
      return;
    }

    const visibleTiles = this.#pinVisibleTiles(active.id, requestedTier, viewport, pinned);
    if (!visibleTiles.length) {
      this.#showLevelTier(active.id, this.displayedTiers.get(active.id) ?? "z0");
      this.activeLevelId = active.id;
      this.#finishRefresh(pinned);
      this.#loadRelatedLevels(relatedLevelIds, requestedTier, viewport, pinned, generation);
      return;
    }
    this.#keepLevelUntilReady(active.id, requestedTier, visibleTiles);
    const highDetail = Promise.all(visibleTiles.map(tile => this.#ensureTile(
      activeLevel,
      this.#tier(activeLevel, requestedTier),
      tile,
      pinned,
      generation,
      ACTIVE_HD_QUEUE_PRIORITY
    )));
    this.#loadRelatedLevels(relatedLevelIds, requestedTier, viewport, pinned, generation);
    await highDetail;
    if (!this.generations.isCurrent(generation)) return;
    this.#showLevelTier(active.id, requestedTier);
    this.activeLevelId = active.id;
    this.activeTier = requestedTier;
    this.#finishRefresh(pinned);
  }

  #showLevelTier(levelId, tierId, {includeLow = false} = {}) {
    this.#setLevelDisplay(levelId, tierId, {includeLow});
    if (!includeLow) this.displayedTiers.set(levelId, tierId);
  }

  #revealLevel(levelId, tierId, options) {
    this.#showLevelTier(levelId, tierId, options);
    const container = this.containers.get(levelId);
    if (container) container.visible = true;
    canvas.primary.renderDirty = true;
  }

  #keepLevelUntilReady(levelId, requestedTier, tiles) {
    if (this.#hasTiles(levelId, requestedTier, tiles)) return;
    const previousTier = this.displayedTiers.get(levelId) ?? "z0";
    this.#showLevelTier(levelId, previousTier, {includeLow: previousTier !== "z0"});
  }

  #pinVisibleTiles(levelId, tierId, viewport, pinned) {
    const level = this.manifest.levels.find(candidate => candidate.id === levelId);
    if (!level) return [];
    const tiles = selectVisibleTiles(this.#tier(level, tierId).tiles, viewport);
    for (const tile of tiles) pinned.add(this.#tileKey(levelId, tierId, tile.id));
    return tiles;
  }

  #loadRelatedLevels(levelIds, requestedTier, viewport, pinned, generation) {
    void (async () => {
      for (const levelId of levelIds) {
        await this.#ensureLevelFallback(levelId, pinned, generation);
        if (!this.generations.isCurrent(generation)) return;
        this.#hideNativeMesh(levelId);
        if (requestedTier === "z0") {
          this.#revealLevel(levelId, "z0");
          continue;
        }
        const level = this.manifest.levels.find(candidate => candidate.id === levelId);
        if (!level) continue;
        const tiles = this.#pinVisibleTiles(levelId, requestedTier, viewport, pinned);
        if (!tiles.length) {
          this.#revealLevel(levelId, this.displayedTiers.get(levelId) ?? "z0");
          continue;
        }
        this.#keepLevelUntilReady(levelId, requestedTier, tiles);
        const container = this.containers.get(levelId);
        if (container) container.visible = true;
        canvas.primary.renderDirty = true;
        await Promise.all(tiles.map(tile => this.#ensureTile(
          level,
          this.#tier(level, requestedTier),
          tile,
          pinned,
          generation,
          RELATED_HD_QUEUE_PRIORITY
        )));
        if (!this.generations.isCurrent(generation)) return;
        this.#showLevelTier(levelId, requestedTier);
        canvas.primary.renderDirty = true;
      }
    })().catch(error => {
      if (!(error instanceof StaleRequestError)) this.#warnAndRestore(error);
    });
  }

  #pinLevelFallback(levelId, pinned) {
    const level = this.manifest.levels.find(candidate => candidate.id === levelId);
    if (!level) return null;
    const lowTier = this.#tier(level, "z0");
    const lowTile = lowTier.tiles[0];
    pinned.add(this.#tileKey(levelId, "z0", lowTile.id));
    return {level, lowTier, lowTile};
  }

  async #ensureLevelFallback(levelId, pinned, generation) {
    const fallback = this.#pinLevelFallback(levelId, pinned);
    if (!fallback) return;
    await this.#ensureTile(fallback.level, fallback.lowTier, fallback.lowTile, pinned, generation);
  }

  #finishRefresh(pinned) {
    for (const [key, record] of this.records) {
      if (pinned.has(key)) record.lastUsed = Date.now();
    }
    for (const [key, record] of this.cache.evict(pinned)) this.#destroyRecord(record, key);
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.#releaseOffscreen(pinned), RELEASE_DELAY_MS);
    canvas.primary.renderDirty = true;
  }

  #releaseOffscreen(pinned) {
    if (this.destroyed) return;
    const cutoff = Date.now() - RELEASE_DELAY_MS;
    for (const [key, record] of this.records) {
      if (pinned.has(key) || record.lastUsed > cutoff) continue;
      this.cache.delete(key);
      this.#destroyRecord(record, key);
    }
    canvas.primary.renderDirty = true;
  }

  async #ensureTile(level, tier, tile, pinned, generation, priority) {
    const key = this.#tileKey(level.id, tier.id, tile.id);
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    let pending = this.pendingLoads.get(key);
    if (pending) {
      pending.generation = generation;
      return pending.promise;
    }
    pending = {generation, promise: null};
    const queuePriority = priority ?? (tier.id === "z0" ? FALLBACK_QUEUE_PRIORITY : ACTIVE_HD_QUEUE_PRIORITY);
    pending.promise = this.queue.add(async () => {
        this.generations.assertCurrent(pending.generation);
        await this.#waitForAssetUnload(tile.path);
        this.generations.assertCurrent(pending.generation);
        const texture = await foundry.canvas.loadTexture(tile.path);
        if (!texture) throw new Error(`Foundry returned no texture for ${tile.path}.`);
        if (this.destroyed) throw new Error(`Discarded texture ${tile.path} after Scene teardown.`);
        if (!this.generations.isCurrent(pending.generation)) {
          texture.destroy(false);
          if (tier.id !== "z0") await this.#unloadAsset(tile.path);
          throw new StaleRequestError();
        }
        const framed = this.#frameTexture(texture, tile.frame);
        const mesh = new foundry.canvas.primary.PrimarySpriteMesh({
          name: `ktx2.${level.id}.${tier.id}.${tile.id}`,
          texture: framed
        });
        mesh.anchor.set(0, 0);
        const position = scenePointToCanvasPoint(tile.scene, canvas.dimensions.sceneRect);
        mesh.position.set(position.x, position.y);
        mesh.width = tile.scene.width;
        mesh.height = tile.scene.height;
        mesh.visible = false;
        mesh.eventMode = "none";
        const record = {
          key,
          levelId: level.id,
          tierId: tier.id,
          tileId: tile.id,
          path: tile.path,
          texture,
          framed,
          mesh,
          bytes: tile.pixel.width * tile.pixel.height * 4,
          lastUsed: Date.now()
        };
        this.containers.get(level.id).addChild(mesh);
        this.#configureBackgroundMesh(mesh, level.id);
        this.records.set(key, record);
        const evicted = this.cache.set(key, record, record.bytes, pinned);
        for (const [evictedKey, evictedRecord] of evicted) this.#destroyRecord(evictedRecord, evictedKey);
        return record;
      }, queuePriority).finally(() => {
        if (this.pendingLoads.get(key) === pending) this.pendingLoads.delete(key);
      });
    this.pendingLoads.set(key, pending);
    return pending.promise;
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
    if (record.mesh?.parent) record.mesh.parent.removeChild(record.mesh);
    record.mesh?.destroy({children: true, texture: false, textureSource: false});
    if (record.framed && record.framed !== record.texture) record.framed.destroy(false);
    record.texture?.destroy(false);
    if (record.tierId !== "z0") void this.#unloadAsset(record.path);
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

  #warnAndRestore(error) {
    console.error(`${MODULE_ID} | High-resolution map streaming failed.`, error);
    this.#restoreAllNativeMeshes();
    for (const container of this.containers.values()) container.visible = false;
    if (!this.warningShown && game.user?.isGM) {
      ui.notifications.warn(`High-resolution map streaming failed on ${this.#sceneLabel()}. Foundry restored the low-resolution backgrounds; check the console for details.`);
      this.warningShown = true;
    }
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
    hint: "Choose automatic zoom-based map detail or force one pyramid tier for this browser.",
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

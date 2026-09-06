import assert from "node:assert/strict";
import test from "node:test";

test("flagged scenes register the KTX2 SceneManager even without a matching version", async () => {
  const once = new Map();
  const on = new Map();
  const settings = [];
  const moduleRecord = {};

  globalThis.foundry = {
    canvas: {
      SceneManager: class {
        constructor(scene) {
          this.scene = scene;
        }
      },
      primary: {PrimaryCanvasContainer: class {}},
      groups: {PrimaryCanvasGroup: {SORT_LAYERS: {SCENE: 0}}}
    }
  };
  globalThis.Hooks = {
    once: (name, callback) => once.set(name, callback),
    on: (name, callback) => on.set(name, callback)
  };
  globalThis.CONFIG = {Canvas: {managedScenes: {}}};
  globalThis.canvas = {manager: null};
  globalThis.game = {
    settings: {register: (...args) => settings.push(args)},
    scenes: [],
    modules: new Map([["theiks-ktx2-renderer", moduleRecord]]),
    user: {isGM: true}
  };
  globalThis.ui = {notifications: {error() {}}};

  const {Ktx2MapManager} = await import(`../scripts/ktx2-renderer.js?test=${Date.now()}`);
  const flagged = {
    id: "world-scene-id",
    levels: [],
    getFlag: () => ({manifest: "modules/example-map/assets/pyramid/manifest.json"})
  };
  game.scenes = [flagged];
  once.get("init")();
  assert.equal(settings.length, 1);
  assert.equal(settings[0][0], "theiks-ktx2-renderer");
  assert.deepEqual(Object.keys(settings[0][2].choices), ["auto", "z0", "z1", "z2"]);
  assert.equal(settings[0][2].default, "auto");
  assert.equal(CONFIG.Canvas.managedScenes[flagged.id], Ktx2MapManager);

  once.get("setup")();
  assert.equal(CONFIG.Canvas.managedScenes[flagged.id], Ktx2MapManager);

  const newerFlag = {
    id: flagged.id,
    getFlag: () => ({version: 99, manifest: "modules/example-map/assets/pyramid/manifest.json"})
  };
  on.get("updateScene")(newerFlag);
  assert.equal(CONFIG.Canvas.managedScenes[flagged.id], Ktx2MapManager);

  const unflagged = {id: flagged.id, getFlag: () => undefined};
  on.get("updateScene")(unflagged);
  assert.equal(CONFIG.Canvas.managedScenes[flagged.id], undefined);

  once.get("ready")();
  assert.equal(typeof moduleRecord.api.getMapStreamingStats, "function");

  const manager = new Ktx2MapManager({id: "stats-scene"});
  assert.deepEqual(manager.getStats(), {
    sceneId: "stats-scene",
    activeLevelId: null,
    activeTier: null,
    loadedTextures: 0,
    pendingTextures: 0,
    estimatedCacheBytes: 0,
    cacheBudgetBytes: 384 * 1024 * 1024,
    queuedTiles: 0,
    inFlightTiles: 0,
    failedTiles: 0,
    visibleSlots: 0,
    prefetchedTiles: 0,
    queuedTextures: 0,
    inFlightTextures: 0,
    failedTextures: 0,
    visibleSlotCount: 0,
    prefetchedTextures: 0
  });
});

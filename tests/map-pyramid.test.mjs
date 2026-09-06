import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  ByteLruCache,
  canvasRectToSceneRect,
  contentFrameIsTransparent,
  createTileLayout,
  expectedMipCount,
  KTX2_IDENTIFIER,
  markKtxPremultiplied,
  masterFilename,
  parseOverallSsim,
  performanceLoadConcurrency,
  posixJoin,
  premultiplyRgba,
  PriorityLoadQueue,
  QueueCancelledError,
  resolveDisplaySlot,
  resolveNativeLevelId,
  RequestGeneration,
  scenePointToCanvasPoint,
  selectLod,
  selectTileDemand,
  selectVisibleTiles,
  semanticTier,
  StaleRequestError,
  retryDelay,
  validateAscendingTierDensities,
  validateManifestTileEntry,
  orderedVisibleLevelIds,
  visibleSceneLevelIds
} from "../tools/pyramid-lib.mjs";
import {parseCli} from "../tools/pyramid.mjs";

const config = {
  scene: {
    width: 6700,
    height: 6500,
    gridSize: 100,
    masterWidth: 13400,
    masterHeight: 13000,
    masterGridSize: 200
  }
};

const tiers = {
  z0: {id: "z0", gridPixels: 50, columns: [67], rows: [65]},
  z1: {id: "z1", gridPixels: 100, columns: [34, 33], rows: [33, 32]},
  z2: {id: "z2", gridPixels: 200, columns: [17, 17, 17, 16], rows: [17, 16, 16, 16]}
};

test("tile layouts preserve odd grid dimensions and safe texture sizes", () => {
  const z0 = createTileLayout(config, tiers.z0);
  const z1 = createTileLayout(config, tiers.z1);
  const z2 = createTileLayout(config, tiers.z2);
  assert.equal(z0.length, 1);
  assert.equal(z1.length, 4);
  assert.equal(z2.length, 16);
  assert.deepEqual(z1.at(-1).scene, {x: 3400, y: 3300, width: 3300, height: 3200});
  assert.deepEqual(z2.at(-1).scene, {x: 5100, y: 4900, width: 1600, height: 1600});
  assert.equal(Math.max(...z2.map(tile => tile.pixel.width)), 3408);
  assert.equal(Math.max(...z2.map(tile => tile.pixel.height)), 3408);
  assert.ok(z2.every(tile => tile.frame.x === 4 && tile.frame.y === 4));
  assert.deepEqual(z0[0].pixel, {width: 3352, height: 3252});
  assert.deepEqual(z0[0].frame, {x: 1, y: 1, width: 3350, height: 3250});
  assert.ok([...z0, ...z1, ...z2].every(tile => !(tile.pixel.width % 4) && !(tile.pixel.height % 4)));
});

test("edge tiles extend missing gutters while internal tiles include adjacent source pixels", () => {
  const layout = createTileLayout(config, tiers.z2);
  const topLeft = layout[0];
  const internal = layout.find(tile => tile.row === 1 && tile.column === 1);
  assert.deepEqual(topLeft.extend, {left: 4, top: 4, right: 0, bottom: 0});
  assert.deepEqual(internal.extend, {left: 0, top: 0, right: 0, bottom: 0});
  assert.equal(internal.source.cropX, internal.source.x - 4);
  assert.equal(internal.source.cropY, internal.source.y - 4);
});

test("auto LOD uses hysteresis and forced modes bypass it", () => {
  assert.equal(selectLod(0.44, null), "z0");
  assert.equal(selectLod(0.45, null), "z1");
  assert.equal(selectLod(0.9, null), "z2");
  assert.equal(selectLod(0.8, "z2"), "z2");
  assert.equal(selectLod(0.76, "z2"), "z1");
  assert.equal(selectLod(0.4, "z1"), "z1");
  assert.equal(selectLod(0.38, "z1"), "z0");
  assert.equal(selectLod(0.1, "z2", "z1"), "z1");
  assert.equal(selectLod(0.9, null, undefined), "z2");
  assert.equal(selectLod(0.1, null, null), "z0");
});

test("visible tile selection includes an optional neighboring ring", () => {
  const layout = createTileLayout(config, tiers.z2);
  const withoutMargin = selectVisibleTiles(layout, {x: 100, y: 100, width: 200, height: 200});
  const withMargin = selectVisibleTiles(layout, {x: 100, y: 100, width: 200, height: 200}, 1700);
  assert.deepEqual(withoutMargin.map(tile => tile.id), ["0-0"]);
  assert.ok(withMargin.length > withoutMargin.length);
  assert.ok(withMargin.some(tile => tile.id === "1-1"));
});

test("visible and prefetched demand are separate", () => {
  const layout = createTileLayout(config, tiers.z2);
  const demand = selectTileDemand(layout, {x: 100, y: 100, width: 200, height: 200}, 1700);
  assert.deepEqual(demand.visible.map(tile => tile.id), ["0-0"]);
  assert.ok(demand.prefetched.some(tile => tile.id === "1-1"));
  assert.ok(demand.prefetched.every(tile => tile.id !== "0-0"));
});

test("density-driven LOD handles five tiers and semantic settings", () => {
  const ladder = [0.25, 0.5, 1, 2, 4].map((density, index) => ({id: `z${index}`, density}));
  assert.equal(selectLod(0.44, null, "auto", ladder), "z1");
  assert.equal(selectLod(0.45, "z1", "auto", ladder), "z2");
  assert.equal(selectLod(0.76, "z3", "auto", ladder), "z2");
  assert.equal(semanticTier(ladder, "z0"), "z0");
  assert.equal(semanticTier(ladder, "z1"), "z2");
  assert.equal(semanticTier(ladder, "z2"), "z4");
  const tied = [{id: "low", density: 0.75}, {id: "high", density: 1.25}];
  assert.equal(semanticTier(tied, "z1"), "high");
  assert.throws(() => validateAscendingTierDensities([ladder[1], ladder[0]]), /strictly ascending/);
});

test("fallback slots crop multiple root tiles without target overlap", () => {
  const roots = [
    {id: "left", scene: {x: 0, y: 0, width: 100, height: 100}, frame: {x: 2, y: 2, width: 50, height: 50}},
    {id: "right", scene: {x: 100, y: 0, width: 100, height: 100}, frame: {x: 2, y: 2, width: 50, height: 50}}
  ];
  const target = {id: "wide", scene: {x: 50, y: 0, width: 100, height: 100}, frame: {x: 4, y: 4, width: 100, height: 100}};
  const ladder = [{id: "z0", density: 0.5, tiles: roots}, {id: "z1", density: 1, tiles: [target]}];
  const rootKeys = new Set(["floor/z0/left", "floor/z0/right"]);
  const fallback = resolveDisplaySlot("floor", ladder, "z1", target, rootKeys);
  assert.equal(fallback.mode, "fallback");
  assert.deepEqual(fallback.pieces.map(piece => piece.scene), [
    {x: 50, y: 0, width: 50, height: 100},
    {x: 100, y: 0, width: 50, height: 100}
  ]);
  assert.deepEqual(fallback.pieces.map(piece => piece.frame), [
    {x: 27, y: 2, width: 25, height: 50},
    {x: 2, y: 2, width: 25, height: 50}
  ]);
  const targetSlot = resolveDisplaySlot("floor", ladder, "z1", target, new Set([...rootKeys, "floor/z1/wide"]));
  assert.equal(targetSlot.mode, "target");
  assert.equal(targetSlot.pieces.length, 1);
  assert.equal(targetSlot.pieces.some(piece => piece.key?.includes("/z0/")), false);
  assert.equal(resolveDisplaySlot("floor", ladder, "z1", {...target, blank: true}, rootKeys).mode, "blank");
});

test("scene padding offsets tile placement and viewport selection", () => {
  const sceneRect = {x: 670, y: 650, width: 6700, height: 6500};
  const canvasViewport = {x: 4070, y: 3950, width: 800, height: 600};
  assert.deepEqual(scenePointToCanvasPoint({x: 3400, y: 3300}, sceneRect), {x: 4070, y: 3950});
  assert.deepEqual(canvasRectToSceneRect(canvasViewport, sceneRect), {x: 3400, y: 3300, width: 800, height: 600});
  const visible = selectVisibleTiles(createTileLayout(config, tiers.z1), canvasRectToSceneRect(canvasViewport, sceneRect));
  assert.deepEqual(visible.map(tile => tile.id), ["1-1"]);
});

test("native Foundry background mesh names resolve to Level IDs", () => {
  const levels = [
    {id: "ground", index: 0},
    {id: "first", index: 1}
  ];
  assert.equal(resolveNativeLevelId({name: "Level.0.background"}, levels), "ground");
  assert.equal(resolveNativeLevelId({name: "Level.1.background"}, levels), "first");
  assert.equal(resolveNativeLevelId({name: "Level.0.foreground"}, levels), null);
  assert.equal(resolveNativeLevelId({levelId: "future-api"}, levels), "future-api");
});

test("visible floors follow Foundry's Level visibility state, nearest first", () => {
  const levels = [
    {id: "ground", elevation: {bottom: 0}, sort: 300000, isVisible: true},
    {id: "first", elevation: {bottom: 10}, sort: 250000, isVisible: true},
    {id: "roof", elevation: {bottom: 20}, sort: 200000, isVisible: true},
    {id: "basement", elevation: {bottom: -10}, sort: 400000, isVisible: false},
    {id: "oubliette", elevation: {bottom: -40}, sort: 500000, isVisible: false}
  ];
  assert.deepEqual(
    orderedVisibleLevelIds(levels, "roof"),
    ["roof", "first", "ground"]
  );
  const visible = visibleSceneLevelIds(levels, "roof");
  assert.equal(visible.size, 3);
  assert.ok(visible.has("roof"));
  assert.ok(visible.has("first"));
  assert.ok(visible.has("ground"));
  assert.ok(!visible.has("basement"));
  assert.ok(!visible.has("oubliette"));
});

test("byte LRU evicts old unpinned entries and preserves pinned entries", () => {
  const cache = new ByteLruCache(20);
  cache.set("a", {id: "a"}, 10);
  cache.set("b", {id: "b"}, 10);
  cache.get("a");
  const evicted = cache.set("c", {id: "c"}, 10, new Set(["a"]));
  assert.deepEqual(evicted.map(([key]) => key), ["b"]);
  assert.ok(cache.get("a"));
  assert.ok(cache.get("c"));
});

test("load queue honors concurrency, reprioritization, cancellation, and in-flight completion", async () => {
  const queue = new PriorityLoadQueue(1);
  const order = [];
  let release;
  const blocker = queue.enqueue("active", 0, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = queue.enqueue("obsolete", 4, async () => order.push("obsolete"));
  const visible = queue.enqueue("visible", 2, async () => order.push("visible"));
  queue.setPriority("visible", 1);
  queue.cancelWhere(entry => entry.key === "obsolete" || entry.key === "active");
  await assert.rejects(cancelled, QueueCancelledError);
  assert.equal(queue.inFlightCount, 1);
  release("cached");
  assert.equal(await blocker, "cached");
  await visible;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["visible"]);
  assert.equal(queue.queuedCount, 0);
  assert.equal(queue.inFlightCount, 0);
});

test("performance modes select one, two, or four concurrent loads", () => {
  assert.equal(performanceLoadConcurrency(0), 1);
  assert.equal(performanceLoadConcurrency("Low"), 1);
  assert.equal(performanceLoadConcurrency(1), 2);
  assert.equal(performanceLoadConcurrency("Medium"), 2);
  assert.equal(performanceLoadConcurrency(2), 4);
  assert.equal(performanceLoadConcurrency("Maximum"), 4);
});

test("load queue does not exceed its concurrency limit", async () => {
  const queue = new PriorityLoadQueue(2);
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({length: 5}, (_, index) => queue.enqueue(`tile-${index}`, index, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(maximum, 2);
});

test("request generations reject stale asynchronous results", () => {
  const generations = new RequestGeneration();
  const first = generations.next();
  const second = generations.next();
  assert.equal(generations.isCurrent(first), false);
  assert.equal(generations.isCurrent(second), true);
  assert.throws(() => generations.assertCurrent(first), StaleRequestError);
  assert.doesNotThrow(() => generations.assertCurrent(second));
});

test("RGBA premultiplication preserves alpha and clears transparent color", () => {
  const pixels = Buffer.from([100, 50, 25, 128, 200, 100, 50, 0, 10, 20, 30, 255]);
  premultiplyRgba(pixels);
  assert.deepEqual([...pixels], [50, 25, 13, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
});

test("sparse alpha inspection ignores gutters and preserves partial alpha", () => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  pixels[3] = 255;
  const content = {x: 1, y: 1, width: 2, height: 2};
  assert.equal(contentFrameIsTransparent(pixels, 4, 4, content), true);
  pixels[((1 * 4) + 1) * 4 + 3] = 1;
  assert.equal(contentFrameIsTransparent(pixels, 4, 4, content), false);
  pixels[((1 * 4) + 1) * 4 + 3] = 128;
  assert.equal(contentFrameIsTransparent(pixels, 4, 4, content), false);
});

test("blank manifest entries keep geometry and reject asset metadata", () => {
  const geometry = {id: "0-0", scene: {x: 0, y: 0, width: 10, height: 10}, pixel: {width: 12, height: 12}, frame: {x: 1, y: 1, width: 10, height: 10}};
  assert.doesNotThrow(() => validateManifestTileEntry({...geometry, blank: true}));
  assert.throws(() => validateManifestTileEntry({...geometry, blank: true, path: "tile.ktx2"}), /asset fields/);
  assert.doesNotThrow(() => validateManifestTileEntry({...geometry, path: "tile.ktx2"}));
  assert.deepEqual([1, 2, 3, 4].map(retryDelay), [5000, 15000, 60000, 60000]);
});

test("KTX2 premultiplied flag patch only changes the DFD flag", () => {
  const data = Buffer.alloc(128);
  KTX2_IDENTIFIER.copy(data, 0);
  data.writeUInt32LE(64, 20);
  data.writeUInt32LE(32, 24);
  data.writeUInt32LE(7, 40);
  data.writeUInt32LE(80, 48);
  markKtxPremultiplied(data);
  assert.equal(data[95], 1);
  assert.equal(expectedMipCount(64, 32), 7);
});

test("SSIM output parser uses the weakest channel", () => {
  const parsed = parseOverallSsim("Overall:\n SSIM Avg R: +0.991, G: +0.982, B: +0.995, A: +1.000");
  assert.equal(parsed.minimum, 0.982);
});

test("CLI options and master filenames stay independent of the content module path", () => {
  const parsed = parseCli([
    "node",
    "tools/pyramid.mjs",
    "rebuild",
    "--config", "tools/maps/harrowstone-pyramid.json",
    "--masters", "assets/masters",
    "--output", "assets/maps/harrowstone-pyramid",
    "--module-id", "theiks-harrowstone",
    "--module-root", ".",
    "--levels", "ground-floor,roof",
    "--tiers", "z0",
    "--runtime-only"
  ]);
  assert.equal(parsed.command, "rebuild");
  assert.equal(parsed.flags.get("module-id"), "theiks-harrowstone");
  assert.equal(parsed.flags.get("levels"), "ground-floor,roof");
  assert.equal(parsed.flags.get("runtime-only"), true);
  assert.equal(masterFilename({master: "assets/masters/ground-floor.webp"}), "ground-floor.webp");
  assert.equal(masterFilename({master: "ground-floor.webp"}), "ground-floor.webp");
  assert.equal(
    posixJoin("modules", "theiks-harrowstone", "assets/maps/harrowstone-pyramid"),
    "modules/theiks-harrowstone/assets/maps/harrowstone-pyramid"
  );
  assert.equal(path.basename("assets/masters/ground-floor.webp"), "ground-floor.webp");
});

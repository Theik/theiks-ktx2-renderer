import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  ByteLruCache,
  canvasRectToSceneRect,
  createTileLayout,
  expectedMipCount,
  KTX2_IDENTIFIER,
  markKtxPremultiplied,
  masterFilename,
  parseOverallSsim,
  posixJoin,
  premultiplyRgba,
  resolveNativeLevelId,
  RequestGeneration,
  scenePointToCanvasPoint,
  selectLod,
  selectVisibleTiles,
  StaleRequestError,
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

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {createTileLayout, resolveTierGutter} from "../tools/pyramid-lib.mjs";
import {
  parseCli,
  parseSceneDocument,
  pickGridPixels,
  proposeConfig,
  proposeTiers,
  slugify,
  splitDimension
} from "../tools/propose-pyramid.mjs";

test("40x30 / 100 px grid / 200 px masters uses one z0 tile and splits HD at 4096", async () => {
  const config = proposeConfig({
    width: 4000,
    height: 3000,
    gridSize: 100,
    padding: 0.25,
    masterGridSize: 200
  });
  assert.deepEqual(pickGridPixels(100, 200), {z0: 50, z1: 100, z2: 200});
  assert.deepEqual(config.tiers[0], {id: "z0", gridPixels: 50, columns: [40], rows: [30]});
  assert.deepEqual(config.tiers[1], {id: "z1", gridPixels: 100, columns: [40], rows: [30]});
  assert.deepEqual(config.tiers[2], {id: "z2", gridPixels: 200, columns: [20, 20], rows: [15, 15]});
  assert.deepEqual(config.tiers.map(tier => resolveTierGutter(config, tier)), [2, 2, 4]);
  assert.ok(config.tiers.every(tier => !Object.hasOwn(tier, "gutter")));
  assert.equal(config.encoder.mipLevels, 1);
  assert.equal(config.encoder.primaryEncoding, "uastc");
  const example = JSON.parse(
    await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/pyramid.json"), "utf8")
  );
  assert.deepEqual(example.tiers, config.tiers);
  assert.deepEqual(example.encoder, config.encoder);
  for (const tier of config.tiers) {
    const tiles = createTileLayout(config, tier);
    const legacyTiles = createTileLayout(config, {...tier, gutter: resolveTierGutter(config, tier)});
    assert.deepEqual(tiles, legacyTiles);
    assert.ok(tiles.every(tile => tile.pixel.width < 4096 && tile.pixel.height < 4096));
    assert.ok(tiles.every(tile => !(tile.pixel.width % 4) && !(tile.pixel.height % 4)));
  }
});

test("67x65 odd grids stay 4x4 aligned with nearly equal HD splits", () => {
  const tiers = proposeTiers(67, 65, 100, 200);
  assert.deepEqual(tiers[0], {id: "z0", gridPixels: 50, columns: [67], rows: [65]});
  assert.deepEqual(tiers[1], {id: "z1", gridPixels: 100, columns: [34, 33], rows: [33, 32]});
  assert.deepEqual(tiers[2], {
    id: "z2",
    gridPixels: 200,
    columns: [17, 17, 17, 16],
    rows: [17, 16, 16, 16]
  });
  const config = proposeConfig({
    width: 6700,
    height: 6500,
    gridSize: 100,
    masterWidth: 13400,
    masterHeight: 13000,
    masterGridSize: 200
  });
  assert.deepEqual(config.tiers.map(tier => resolveTierGutter(config, tier)), [1, 2, 4]);
  assert.equal(Math.max(...createTileLayout(config, config.tiers[2]).map(tile => tile.pixel.width)), 3408);
});

test("explicit legacy gutters remain authoritative", () => {
  const config = proposeConfig({
    width: 4000,
    height: 3000,
    gridSize: 100,
    masterGridSize: 200
  });
  const tier = {...config.tiers[1], gutter: 4};
  assert.equal(resolveTierGutter(config, tier), 4);
  assert.ok(createTileLayout(config, tier).every(tile => tile.frame.x === 4 && tile.frame.y === 4));
  assert.throws(
    () => resolveTierGutter(config, {...config.tiers[1], gutter: 3}),
    /does not keep every tile under 4096 pixels and aligned to 4x4 blocks/
  );
});

test("automatic gutters reject incompatible fixed partitions", () => {
  const config = {
    scene: {width: 300, height: 300, gridSize: 100, masterWidth: 600, masterHeight: 600, masterGridSize: 200}
  };
  const tier = {id: "z0", gridPixels: 50, columns: [1, 2], rows: [3]};
  assert.throws(
    () => resolveTierGutter(config, tier),
    /Re-run tools\/propose-pyramid\.mjs to generate compatible partitions/
  );
});

test("150 px grids with 300 px masters use 75/150/300 output pixels", () => {
  const config = proposeConfig({
    width: 6000,
    height: 4500,
    gridSize: 150,
    masterGridSize: 300
  });
  assert.deepEqual(pickGridPixels(150, 300), {z0: 75, z1: 150, z2: 300});
  assert.equal(config.scene.masterWidth, 12000);
  assert.equal(config.scene.masterHeight, 9000);
  assert.deepEqual(config.tiers.map(tier => tier.gridPixels), [75, 150, 300]);
  for (const tier of config.tiers) {
    assert.ok(createTileLayout(config, tier).every(tile => !(tile.pixel.width % 4)));
  }
});

test("splitDimension prefers equal parts that already fit", () => {
  assert.deepEqual(splitDimension(40, 50, 2), [40]);
  assert.deepEqual(splitDimension(67, 200, 4), [17, 17, 17, 16]);
  assert.deepEqual(splitDimension(65, 200, 4), [17, 16, 16, 16]);
});

test("Scene JSON supplies size, padding, and slugified levels", () => {
  const parsed = parseSceneDocument({
    width: 4000,
    height: 3000,
    padding: 0.1,
    grid: {size: 100},
    levels: [{_id: "abc123", name: "Ground Floor"}]
  });
  assert.equal(parsed.gridSize, 100);
  assert.equal(parsed.padding, 0.1);
  assert.deepEqual(parsed.levels, [{
    id: "abc123",
    name: "Ground Floor",
    slug: "ground-floor",
    master: "ground-floor.webp"
  }]);
  assert.equal(slugify("First Floor"), "first-floor");
});

test("CLI collects repeated --level flags", () => {
  const parsed = parseCli([
    "node",
    "tools/propose-pyramid.mjs",
    "--width", "4000",
    "--height", "3000",
    "--grid-size", "100",
    "--out", "tools/maps/pyramid.json",
    "--level", "id1:One:one:one.webp",
    "--level", "id2:Two:two:two.webp"
  ]);
  assert.equal(parsed.flags.get("grid-size"), "100");
  assert.deepEqual(parsed.levels, ["id1:One:one:one.webp", "id2:Two:two:two.webp"]);
});

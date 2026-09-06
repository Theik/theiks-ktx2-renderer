import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  masterStem,
  supportedMasterSuffixes,
  validateMasterMetadata
} from "../tools/master-image.mjs";
import {createPremultipliedPng} from "../tools/pyramid.mjs";
import {buildProposedConfig, inspectMasters} from "../tools/propose-pyramid.mjs";

sharp.cache(false);

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ktx2-master-test-"));
  t.after(() => rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  return directory;
}

async function writeImage(filename, format, {width = 800, height = 400, alpha = 1, channels = 4} = {}) {
  await sharp({
    create: {
      width,
      height,
      channels,
      background: {r: 200, g: 100, b: 50, alpha}
    }
  })[format]().toFile(filename);
}

test("master suffixes follow the formats supported by Sharp", () => {
  const suffixes = supportedMasterSuffixes();
  for (const suffix of [".webp", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".avif"]) {
    assert.ok(suffixes.includes(suffix), `${suffix} should be supported by the installed Sharp build`);
  }
  assert.equal(masterStem("Upper.Floor.SVG.GZ"), "Upper.Floor");
});

test("Scene proposal resolves mixed PNG and JPEG masters by floor slug", async t => {
  const directory = await tempDirectory(t);
  const masters = path.join(directory, "masters");
  await mkdir(masters);
  await writeImage(path.join(masters, "ground-floor.png"), "png", {alpha: 0.5});
  await writeImage(path.join(masters, "first-floor.jpg"), "jpeg", {channels: 3});
  const scenePath = path.join(directory, "scene.json");
  await writeFile(scenePath, JSON.stringify({
    width: 400,
    height: 200,
    grid: {size: 100},
    levels: [
      {_id: "ground", name: "Ground Floor"},
      {_id: "first", name: "First Floor"}
    ]
  }));

  const config = await buildProposedConfig({
    flags: new Map([["scene", scenePath], ["masters", masters]]),
    levels: []
  });

  assert.equal(config.scene.masterWidth, 800);
  assert.equal(config.scene.masterHeight, 400);
  assert.deepEqual(config.levels.map(level => level.master), ["ground-floor.png", "first-floor.jpg"]);
});

test("explicit master filenames remain exact and WebP remains supported", async t => {
  const directory = await tempDirectory(t);
  await writeImage(path.join(directory, "floor.png"), "png");
  await writeImage(path.join(directory, "legacy.webp"), "webp");

  await assert.rejects(
    inspectMasters(directory, ["floor.jpg"]),
    /Missing master floor\.jpg/
  );
  const inspected = await inspectMasters(directory, ["legacy.webp"]);
  assert.equal(inspected[0].format, "webp");
});

test("proposer rejects ambiguous stems and unsupported explicit files", async t => {
  const duplicates = await tempDirectory(t);
  await writeImage(path.join(duplicates, "floor.png"), "png");
  await writeImage(path.join(duplicates, "floor.jpg"), "jpeg", {channels: 3});
  await assert.rejects(
    inspectMasters(duplicates),
    /Multiple master images match floor: floor\.jpg, floor\.png/
  );

  const unsupported = await tempDirectory(t);
  await writeFile(path.join(unsupported, "floor.txt"), "not an image");
  await assert.rejects(
    inspectMasters(unsupported, ["floor.webp"], {matchByStem: true}),
    /floor\.txt: its file extension is not supported by this Sharp build/
  );
});

test("animated and multi-page metadata is rejected", () => {
  assert.throws(
    () => validateMasterMetadata("floors.gif", {width: 10, height: 10, pages: 2}),
    /animated and multi-page master images are not supported/
  );
});

test("tile conversion preserves PNG alpha and gives JPEG opaque alpha", async t => {
  const directory = await tempDirectory(t);
  const pngMaster = path.join(directory, "floor.png");
  const jpegMaster = path.join(directory, "floor.jpg");
  const pngTile = path.join(directory, "png-tile.png");
  const jpegTile = path.join(directory, "jpeg-tile.png");
  await writeImage(pngMaster, "png", {width: 4, height: 4, alpha: 0.5});
  await writeImage(jpegMaster, "jpeg", {width: 4, height: 4, channels: 3});
  const tile = {
    source: {cropX: 0, cropY: 0, cropWidth: 4, cropHeight: 4},
    resize: {width: 4, height: 4},
    extend: {left: 0, top: 0, right: 0, bottom: 0}
  };

  await createPremultipliedPng(pngMaster, tile, pngTile);
  await createPremultipliedPng(jpegMaster, tile, jpegTile);

  const png = await sharp(pngTile).raw().toBuffer({resolveWithObject: true});
  const jpeg = await sharp(jpegTile).raw().toBuffer({resolveWithObject: true});
  assert.equal(png.info.channels, 4);
  assert.equal(jpeg.info.channels, 4);
  assert.ok([...png.data].filter((_, index) => index % 4 === 3).every(alpha => alpha === 128));
  assert.ok([...jpeg.data].filter((_, index) => index % 4 === 3).every(alpha => alpha === 255));
});

test("tile preparation detects transparent content independently of an opaque gutter", async t => {
  const directory = await tempDirectory(t);
  const master = path.join(directory, "sparse.png");
  const output = path.join(directory, "tile.png");
  const pixels = Buffer.alloc(4 * 4 * 4, 255);
  for (let y = 1; y < 3; y += 1) {
    for (let x = 1; x < 3; x += 1) pixels[((y * 4) + x) * 4 + 3] = 0;
  }
  await sharp(pixels, {raw: {width: 4, height: 4, channels: 4}}).png().toFile(master);
  const tile = {
    source: {cropX: 0, cropY: 0, cropWidth: 4, cropHeight: 4},
    resize: {width: 4, height: 4},
    extend: {left: 0, top: 0, right: 0, bottom: 0},
    frame: {x: 1, y: 1, width: 2, height: 2}
  };
  assert.equal((await createPremultipliedPng(master, tile, output)).blank, true);

  pixels[((1 * 4) + 1) * 4 + 3] = 128;
  await sharp(pixels, {raw: {width: 4, height: 4, channels: 4}}).png().toFile(master);
  assert.equal((await createPremultipliedPng(master, tile, output)).blank, false);
});

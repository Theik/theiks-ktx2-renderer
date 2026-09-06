import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import sharp from "sharp";

import {
  createTileLayout,
  contentFrameIsTransparent,
  exists,
  fileSize,
  markKtxPremultiplied,
  masterFilename,
  parseOverallSsim,
  posixJoin,
  premultiplyRgba,
  readKtx2Header,
  resolveTierGutter,
  runProcess,
  sha256File,
  sha256Json,
  validateManifestTileEntry
} from "./pyramid-lib.mjs";
import {inspectMasterImage, normalizedMasterPipeline} from "./master-image.mjs";

const RENDERER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_FILE_LIMIT = 95 * 1024 * 1024;
const USAGE = `Usage: node tools/pyramid.mjs <doctor|rebuild|verify>
  --config <pyramid.json>
  --masters <dir>
  --output <dir>
  --module-id <foundryModuleId>
  [--module-root <dir>]
  [--levels all|slug,...] [--tiers all|z0,z1,...]
  [--runtime-only]`;

export function parseCli(argv) {
  const args = argv.slice(2);
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--runtime-only") {
      flags.set("runtime-only", true);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.\n${USAGE}`);
      flags.set(name, value);
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return {command: positional[0], extra: positional.slice(1), flags};
}

export async function createContext(argv = process.argv) {
  const {command, flags} = parseCli(argv);
  if (!["doctor", "rebuild", "verify"].includes(command)) throw new Error(USAGE);
  for (const name of ["config", "masters", "output", "module-id"]) {
    if (!flags.get(name)) throw new Error(`Missing --${name}.\n${USAGE}`);
  }

  const configPath = path.resolve(flags.get("config"));
  const mastersDir = path.resolve(flags.get("masters"));
  const outputRoot = path.resolve(flags.get("output"));
  const moduleId = String(flags.get("module-id"));
  const moduleRoot = path.resolve(flags.get("module-root") ?? process.cwd());
  const relativeOutput = path.relative(moduleRoot, outputRoot).split(path.sep).join("/");
  if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    throw new Error("--output must be a directory inside --module-root (defaults to the current working directory).");
  }

  return {
    command,
    runtimeOnly: Boolean(flags.get("runtime-only")),
    levelsArg: flags.get("levels"),
    tiersArg: flags.get("tiers"),
    configPath,
    mastersDir,
    outputRoot,
    moduleId,
    moduleRoot,
    modulePath: posixJoin("modules", moduleId, relativeOutput),
    modulePrefix: `modules/${moduleId}/`,
    manifestPath: path.join(outputRoot, "manifest.json"),
    stagingRoot: path.join(moduleRoot, ".map-staging"),
    config: JSON.parse(await readFile(configPath, "utf8"))
  };
}

function requestedLevels(ctx) {
  if (!ctx.levelsArg || ctx.levelsArg === "all") return ctx.config.levels;
  const requested = new Set(ctx.levelsArg.split(",").map(value => value.trim()).filter(Boolean));
  const selected = ctx.config.levels.filter(level => requested.has(level.slug));
  const unknown = [...requested].filter(slug => !ctx.config.levels.some(level => level.slug === slug));
  if (unknown.length) throw new Error(`Unknown map level(s): ${unknown.join(", ")}`);
  return selected;
}

function requestedTiers(ctx) {
  if (!ctx.tiersArg || ctx.tiersArg === "all") return ctx.config.tiers;
  const requested = new Set(ctx.tiersArg.split(",").map(value => value.trim()).filter(Boolean));
  const selected = ctx.config.tiers.filter(tier => requested.has(tier.id));
  const unknown = [...requested].filter(id => !ctx.config.tiers.some(tier => tier.id === id));
  if (unknown.length) throw new Error(`Unknown map tier(s): ${unknown.join(", ")}`);
  return selected;
}

function thumbnailLevel(config) {
  if (config.thumbnailLevel) {
    const match = config.levels.find(level => level.slug === config.thumbnailLevel);
    if (!match) throw new Error(`thumbnailLevel ${config.thumbnailLevel} is not a configured level slug.`);
    return match;
  }
  return config.levels[0];
}

function thumbnailSize(config) {
  const width = Number(config.thumbnail?.width ?? 512);
  const height = Number(config.thumbnail?.height ?? Math.round(width * config.scene.height / config.scene.width));
  return {width, height};
}

function masterPath(ctx, level) {
  return path.join(ctx.mastersDir, masterFilename(level));
}

function assetFilename(ctx, assetPath) {
  if (!assetPath?.startsWith(ctx.modulePrefix)) return null;
  return path.join(ctx.moduleRoot, assetPath.slice(ctx.modulePrefix.length));
}

async function resolveKtxCli(ctx) {
  const executable = process.platform === "win32" ? "ktx.exe" : "ktx";
  const candidates = [
    process.env.KTX_CLI,
    path.join(RENDERER_ROOT, ".tools", "ktx", "bin", executable),
    path.join(ctx.moduleRoot, ".tools", "ktx", "bin", executable),
    "ktx"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const result = await runProcess(candidate, ["--version"], {cwd: ctx.moduleRoot});
      const match = result.output.match(/v?(\d+\.\d+\.\d+)/);
      if (!match) continue;
      if (match[1] !== ctx.config.encoder.version) {
        throw new Error(`Expected KTX-Software ${ctx.config.encoder.version}, found ${match[1]} at ${candidate}.`);
      }
      return candidate;
    } catch (error) {
      if (error.message.startsWith("Expected KTX-Software")) throw error;
    }
  }
  throw new Error(`KTX-Software ${ctx.config.encoder.version} was not found. Set KTX_CLI or install it in .tools/ktx.`);
}

async function inspectMaster(ctx, level) {
  const filename = masterPath(ctx, level);
  const relativeMaster = masterFilename(level);
  if (!(await exists(filename))) throw new Error(`${level.name}: missing local master ${relativeMaster}`);
  const metadata = await inspectMasterImage(filename);
  assert.equal(metadata.width, ctx.config.scene.masterWidth, `${level.name}: incorrect master width.`);
  assert.equal(metadata.height, ctx.config.scene.masterHeight, `${level.name}: incorrect master height.`);
  return {
    path: relativeMaster,
    width: metadata.width,
    height: metadata.height,
    channels: metadata.channels,
    colorSpace: metadata.space,
    sha256: await sha256File(filename),
    bytes: await fileSize(filename)
  };
}

async function doctor(ctx) {
  assert.equal(ctx.config.encoder.mipLevels, 1, "WebGL block-compressed tiles must contain exactly one mip level.");
  const ktxCli = await resolveKtxCli(ctx);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) throw new Error(`Node.js 24 or newer is required, found ${process.versions.node}.`);
  const disk = await statfs(ctx.moduleRoot);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (freeBytes < (3 * 1024 * 1024 * 1024)) throw new Error("At least 3 GiB of free space is required for a full rebuild.");
  for (const tier of ctx.config.tiers) {
    for (const tile of createTileLayout(ctx.config, tier)) {
      if (tile.pixel.width >= 4096 || tile.pixel.height >= 4096) {
        throw new Error(`${tier.id}/${tile.id} exceeds the 4096-pixel safety limit.`);
      }
      if ((tile.pixel.width % 4) || (tile.pixel.height % 4)) {
        throw new Error(`${tier.id}/${tile.id} is not aligned to 4x4 GPU compression blocks.`);
      }
    }
  }
  const masters = [];
  for (const level of ctx.config.levels) masters.push(await inspectMaster(ctx, level));
  console.log(`Node.js ${process.versions.node}`);
  console.log(`Sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`KTX CLI ${ktxCli}`);
  console.log(`Free space ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`);
  for (let index = 0; index < ctx.config.levels.length; index += 1) {
    console.log(`${ctx.config.levels[index].name}: ${masters[index].width}x${masters[index].height}, ${(masters[index].bytes / 1024 / 1024).toFixed(1)} MiB`);
  }
}

export async function createPremultipliedPng(masterFile, tile, outputPath) {
  let pipeline = normalizedMasterPipeline(masterFile)
    .extract({
      left: tile.source.cropX,
      top: tile.source.cropY,
      width: tile.source.cropWidth,
      height: tile.source.cropHeight
    })
    .resize(tile.resize.width, tile.resize.height, {fit: "fill", kernel: sharp.kernel.lanczos3});

  if (Object.values(tile.extend).some(Boolean)) {
    pipeline = pipeline.extend({...tile.extend, extendWith: "copy"});
  }

  const {data, info} = await pipeline.raw().toBuffer({resolveWithObject: true});
  assert.equal(info.channels, 4, `${path.basename(masterFile)}: Sharp did not produce RGBA pixels.`);
  const frame = tile.frame ?? {x: 0, y: 0, width: info.width, height: info.height};
  const blank = contentFrameIsTransparent(data, info.width, info.height, frame);
  premultiplyRgba(data);
  await sharp(data, {raw: info}).png({compressionLevel: 6, adaptiveFiltering: true}).toFile(outputPath);
  return {blank};
}

function commonEncoderArguments(inputPath, outputPath) {
  return [
    "create",
    "--format", "R8G8B8A8_SRGB",
    "--assign-tf", "srgb",
    "--compare-ssim",
    inputPath,
    outputPath
  ];
}

async function encodeTile(ctx, ktxCli, inputPath, outputPath) {
  const uastcArgs = commonEncoderArguments(inputPath, outputPath);
  uastcArgs.splice(3, 0,
    "--encode", "uastc",
    "--uastc-quality", String(ctx.config.encoder.uastcQuality),
    "--zstd", String(ctx.config.encoder.zstdLevel));
  const result = await runProcess(ktxCli, uastcArgs, {cwd: ctx.moduleRoot});
  const ssim = parseOverallSsim(result.output);

  if (!ssim) throw new Error(`Could not parse SSIM for ${path.basename(outputPath)}.`);
  if (ssim.minimum < ctx.config.encoder.minimumSsim) {
    console.warn(`${path.basename(outputPath)} scored ${ssim.minimum.toFixed(6)}, below the ${ctx.config.encoder.minimumSsim.toFixed(2)} target; retaining Foundry-compatible UASTC.`);
  }

  const data = markKtxPremultiplied(await readFile(outputPath));
  await writeFile(outputPath, data);
  await runProcess(ktxCli, ["validate", outputPath], {cwd: ctx.moduleRoot});
  const header = readKtx2Header(data);
  assert.equal(header.levels, ctx.config.encoder.mipLevels, `${path.basename(outputPath)} has an unsafe mip count.`);
  return {
    encoding: "uastc",
    ssim,
    ssimBelowTarget: ssim.minimum < ctx.config.encoder.minimumSsim,
    header,
    bytes: data.length,
    sha256: await sha256File(outputPath)
  };
}

async function buildLevel(ctx, level, ktxCli, stagingRoot, masterInfo, rebuildTierIds, previousLevel) {
  const levelRoot = path.join(stagingRoot, level.slug);
  const temporaryRoot = path.join(os.tmpdir(), `ktx2-pyramid-${process.pid}-${randomUUID()}`);
  const tierEntries = [];
  await mkdir(levelRoot, {recursive: true});
  await mkdir(temporaryRoot, {recursive: true});

  try {
    const leastDensity = Math.min(...ctx.config.tiers.map(candidate => candidate.gridPixels / ctx.config.scene.gridSize));
    for (const tier of ctx.config.tiers) {
      if (!rebuildTierIds.has(tier.id)) {
        const previousTier = previousLevel?.tiers?.find(candidate => candidate.id === tier.id);
        if (!previousTier) throw new Error(`Existing manifest is missing ${level.slug}/${tier.id}.`);
        tierEntries.push(previousTier);
        continue;
      }
      const tierRoot = path.join(levelRoot, tier.id);
      const gutter = resolveTierGutter(ctx.config, tier);
      await mkdir(tierRoot, {recursive: true});
      const tileEntries = [];
      for (const tile of createTileLayout(ctx.config, tier)) {
        const pngPath = path.join(temporaryRoot, `${tier.id}-${tile.id}.png`);
        const outputName = `${tile.id}.ktx2`;
        const outputPath = path.join(tierRoot, outputName);
        process.stdout.write(`${level.name} ${tier.id}/${tile.id}: preparing... `);
        const prepared = await createPremultipliedPng(masterPath(ctx, level), tile, pngPath);
        const density = tier.gridPixels / ctx.config.scene.gridSize;
        if (prepared.blank && density !== leastDensity) {
          await rm(pngPath, {force: true});
          console.log("blank; skipped encoding");
          tileEntries.push({...tile, blank: true});
          continue;
        }
        process.stdout.write("encoding... ");
        const encoded = await encodeTile(ctx, ktxCli, pngPath, outputPath);
        await rm(pngPath, {force: true});
        console.log(`${encoded.encoding}, SSIM ${encoded.ssim.minimum.toFixed(6)}, ${(encoded.bytes / 1024 / 1024).toFixed(2)} MiB`);
        tileEntries.push({
          ...tile,
          path: `${ctx.modulePath}/${level.slug}/${tier.id}/${outputName}`,
          encoding: encoded.encoding,
          ssim: encoded.ssim,
          ssimBelowTarget: encoded.ssimBelowTarget,
          bytes: encoded.bytes,
          sha256: encoded.sha256,
          mipLevels: encoded.header.levels,
          premultipliedAlpha: encoded.header.premultipliedAlpha
        });
      }
      tierEntries.push({
        id: tier.id,
        gridPixels: tier.gridPixels,
        density: tier.gridPixels / ctx.config.scene.gridSize,
        gutter,
        tiles: tileEntries
      });
    }
  } finally {
    await rm(temporaryRoot, {force: true, recursive: true, maxRetries: 10});
  }

  return {
    id: level.id,
    name: level.name,
    slug: level.slug,
    master: masterInfo,
    tiers: tierEntries
  };
}

async function buildThumbnail(ctx, stagingRoot) {
  const source = thumbnailLevel(ctx.config);
  const size = thumbnailSize(ctx.config);
  const destination = path.join(stagingRoot, "thumb.webp");
  await sharp(masterPath(ctx, source), {limitInputPixels: false})
    .resize({width: size.width, height: size.height, fit: "fill", kernel: sharp.kernel.lanczos3})
    .webp({quality: 82, effort: 6})
    .toFile(destination);
  return {
    path: `${ctx.modulePath}/thumb.webp`,
    width: size.width,
    height: size.height,
    bytes: await fileSize(destination),
    sha256: await sha256File(destination)
  };
}

async function readExistingManifest(ctx) {
  if (!(await exists(ctx.manifestPath))) return null;
  return JSON.parse(await readFile(ctx.manifestPath, "utf8"));
}

async function generatedTierMatches(ctx, level, configuredTier) {
  const tier = level?.tiers?.find(candidate => candidate.id === configuredTier.id);
  const expectedTiles = createTileLayout(ctx.config, configuredTier);
  const gutter = resolveTierGutter(ctx.config, configuredTier);
  if (!tier || tier.tiles?.length !== expectedTiles.length || tier.gutter !== gutter) return false;
  for (const expectedTile of expectedTiles) {
    const tile = tier.tiles.find(candidate => candidate.id === expectedTile.id);
    try {
      validateManifestTileEntry(tile);
    } catch {
      return false;
    }
    if (JSON.stringify(tile.scene) !== JSON.stringify(expectedTile.scene)) return false;
    if (tile.pixel?.width !== expectedTile.pixel.width || tile.pixel?.height !== expectedTile.pixel.height) return false;
    if (JSON.stringify(tile.frame) !== JSON.stringify(expectedTile.frame)) return false;
    if (configuredTier.id === ctx.config.tiers[0].id && tile.blank) return false;
    if (tile.blank === true) continue;
    if (!tile.path.startsWith(ctx.modulePrefix) || !tile.sha256) return false;
    if (tile.encoding === "rgba8-zstd") return false;
    if (tile.mipLevels !== ctx.config.encoder.mipLevels) return false;
    const filename = assetFilename(ctx, tile.path);
    if (!filename || !(await exists(filename)) || await sha256File(filename) !== tile.sha256) return false;
  }
  return true;
}

async function generatedLevelMatches(ctx, level) {
  if (!level?.tiers?.length) return false;
  const matches = await Promise.all(ctx.config.tiers.map(tier => generatedTierMatches(ctx, level, tier)));
  return matches.every(Boolean);
}

async function generatedThumbnailMatches(ctx, thumbnail) {
  if (!thumbnail?.path?.startsWith(ctx.modulePrefix) || !thumbnail.sha256) return false;
  const filename = assetFilename(ctx, thumbnail.path);
  return Boolean(filename) && await exists(filename) && await sha256File(filename) === thumbnail.sha256;
}

async function replaceDirectory(source, destination) {
  const backup = `${destination}.old-${randomUUID()}`;
  if (await exists(destination)) await rename(destination, backup);
  try {
    await rename(source, destination);
    await rm(backup, {force: true, recursive: true, maxRetries: 10});
  } catch (error) {
    if (await exists(backup)) await rename(backup, destination);
    throw error;
  }
}

async function rebuild(ctx) {
  const selected = requestedLevels(ctx);
  const selectedTiers = requestedTiers(ctx);
  const existing = await readExistingManifest(ctx);
  if (!existing && (selected.length !== ctx.config.levels.length || selectedTiers.length !== ctx.config.tiers.length)) {
    throw new Error("A partial rebuild requires an existing complete runtime manifest.");
  }
  const configSha256 = sha256Json(ctx.config);
  const configChanged = existing && existing.configSha256 !== configSha256;
  const thumbSlug = thumbnailLevel(ctx.config).slug;

  const masterInfo = new Map();
  const rebuildTiers = new Map();
  const masterChanges = new Set();
  for (const level of selected) {
    const master = await inspectMaster(ctx, level);
    masterInfo.set(level.slug, master);
    const previous = existing?.levels.find(entry => entry.slug === level.slug);
    const masterChanged = previous?.master?.sha256 !== master.sha256;
    if (masterChanged) masterChanges.add(level.slug);
    if (masterChanged && selectedTiers.length !== ctx.config.tiers.length) {
      throw new Error(`${level.name} master changed; rebuild all tiers for that floor.`);
    }
    const selectedTierIds = new Set(selectedTiers.map(tier => tier.id));
    const tierIds = new Set();
    for (const tier of ctx.config.tiers) {
      const matches = !masterChanged && await generatedTierMatches(ctx, previous, tier);
      if (selectedTierIds.has(tier.id)) {
        if (!matches) tierIds.add(tier.id);
      } else if (!matches) {
        throw new Error(`${level.name} ${tier.id} is stale; include it in --tiers or rebuild all tiers.`);
      }
    }
    if (tierIds.size) rebuildTiers.set(level.slug, tierIds);
    else console.log(`${level.name}: unchanged; keeping validated generated tiles.`);
  }

  for (const level of ctx.config.levels.filter(candidate => !selected.some(entry => entry.slug === candidate.slug))) {
    const previous = existing?.levels.find(entry => entry.slug === level.slug);
    if (configChanged && !(await generatedLevelMatches(ctx, previous))) {
      throw new Error(`${level.name} is stale after the configuration change; include that floor in --levels.`);
    }
  }

  const rebuildThumbnail = masterChanges.has(thumbSlug)
    || !existing
    || !(await generatedThumbnailMatches(ctx, existing.thumbnail));
  if (!rebuildTiers.size && !rebuildThumbnail && !configChanged) {
    await rm(ctx.stagingRoot, {force: true, recursive: true, maxRetries: 10});
    console.log("No map outputs changed.");
    return;
  }

  const ktxCli = rebuildTiers.size ? await resolveKtxCli(ctx) : null;
  const stagingRoot = path.join(ctx.stagingRoot, randomUUID());
  await mkdir(stagingRoot, {recursive: true});

  try {
    const levels = [];
    for (const level of ctx.config.levels) {
      const previous = existing?.levels.find(entry => entry.slug === level.slug);
      const tierIds = rebuildTiers.get(level.slug);
      if (!tierIds) {
        if (!previous) throw new Error(`Existing manifest is missing ${level.slug}.`);
        levels.push(previous);
        continue;
      }
      levels.push(await buildLevel(ctx, level, ktxCli, stagingRoot, masterInfo.get(level.slug), tierIds, previous));
    }

    const thumbnail = rebuildThumbnail
      ? await buildThumbnail(ctx, stagingRoot)
      : existing.thumbnail;
    const manifest = {
      schemaVersion: 1,
      moduleId: ctx.moduleId,
      generatedAt: new Date().toISOString(),
      configSha256,
      scene: ctx.config.scene,
      encoder: ctx.config.encoder,
      thumbnail,
      levels
    };

    await mkdir(ctx.outputRoot, {recursive: true});
    for (const [slug, tierIds] of rebuildTiers) {
      for (const tierId of tierIds) {
        await replaceDirectory(path.join(stagingRoot, slug, tierId), path.join(ctx.outputRoot, slug, tierId));
      }
    }
    if (rebuildThumbnail) {
      await rm(path.join(ctx.outputRoot, "thumb.webp"), {force: true});
      await rename(path.join(stagingRoot, "thumb.webp"), path.join(ctx.outputRoot, "thumb.webp"));
    }
    await writeFile(ctx.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${path.relative(ctx.moduleRoot, ctx.manifestPath)} with ${levels.reduce((count, level) => count + level.tiers.reduce((n, tier) => n + tier.tiles.length, 0), 0)} textures.`);
  } finally {
    await rm(ctx.stagingRoot, {force: true, recursive: true, maxRetries: 10});
  }
}

async function verify(ctx) {
  const manifest = JSON.parse(await readFile(ctx.manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported runtime manifest schema.");
  assert.equal(manifest.moduleId, ctx.moduleId, "Runtime manifest belongs to a different module.");
  assert.equal(manifest.configSha256, sha256Json(ctx.config), "Runtime manifest was built from a different configuration.");
  assert.equal(manifest.levels.length, ctx.config.levels.length, "Runtime manifest has the wrong Level count.");
  const ktxCli = ctx.runtimeOnly ? null : await resolveKtxCli(ctx);
  let textureCount = 0;
  let totalBytes = 0;

  for (const configuredLevel of ctx.config.levels) {
    const level = manifest.levels.find(entry => entry.id === configuredLevel.id);
    assert.ok(level, `Manifest is missing ${configuredLevel.name}.`);
    if (!ctx.runtimeOnly) {
      const master = await inspectMaster(ctx, configuredLevel);
      assert.equal(level.master.sha256, master.sha256, `${configuredLevel.name} master has changed; rebuild its tiles.`);
    }
    for (const configuredTier of ctx.config.tiers) {
      const tier = level.tiers.find(entry => entry.id === configuredTier.id);
      assert.ok(tier, `${configuredLevel.name} is missing ${configuredTier.id}.`);
      const expectedLayout = createTileLayout(ctx.config, configuredTier);
      assert.equal(tier.tiles.length, expectedLayout.length, `${configuredLevel.name} ${configuredTier.id} tile count differs.`);
      const expectedFiles = [];
      for (const expectedTile of expectedLayout) {
        const tile = tier.tiles.find(entry => entry.id === expectedTile.id);
        assert.ok(tile, `${configuredLevel.name} ${configuredTier.id} is missing ${expectedTile.id}.`);
        validateManifestTileEntry(tile);
        assert.deepEqual(tile.pixel, expectedTile.pixel, `${configuredLevel.name} ${configuredTier.id}/${tile.id} dimensions differ.`);
        assert.deepEqual(tile.scene, expectedTile.scene, `${configuredLevel.name} ${configuredTier.id}/${tile.id} Scene rectangle differs.`);
        assert.deepEqual(tile.frame, expectedTile.frame, `${configuredLevel.name} ${configuredTier.id}/${tile.id} content frame differs.`);
        assert.ok(configuredTier.id !== ctx.config.tiers[0].id || !tile.blank, `${configuredLevel.name} least-density fallback cannot be blank.`);
        if (tile.blank === true) continue;
        const filename = assetFilename(ctx, tile.path);
        assert.ok(filename, `${tile.path}: is not inside module ${ctx.moduleId}.`);
        const expectedAssetDirectory = posixJoin(ctx.modulePath, configuredLevel.slug, configuredTier.id);
        assert.equal(path.posix.dirname(tile.path), expectedAssetDirectory, `${tile.path}: is not in its manifest tier directory.`);
        expectedFiles.push(path.basename(filename));
        const data = await readFile(filename);
        const header = readKtx2Header(data);
        assert.equal(header.width, tile.pixel.width, `${tile.path}: KTX width differs.`);
        assert.equal(header.height, tile.pixel.height, `${tile.path}: KTX height differs.`);
        assert.equal(header.levels, ctx.config.encoder.mipLevels, `${tile.path}: unsafe mip count for WebGL block compression.`);
        assert.equal(header.premultipliedAlpha, true, `${tile.path}: alpha is not marked premultiplied.`);
        assert.notEqual(tile.encoding, "rgba8-zstd", `${tile.path}: Foundry cannot load uncompressed RGBA8+Zstd through its compressed KTX2 pipeline.`);
        assert.ok(header.width < 4096 && header.height < 4096, `${tile.path}: exceeds 4096 pixels.`);
        assert.ok(data.length < GITHUB_FILE_LIMIT, `${tile.path}: exceeds the 95 MiB repository limit.`);
        assert.equal(await sha256File(filename), tile.sha256, `${tile.path}: hash differs.`);
        if (ktxCli) await runProcess(ktxCli, ["validate", filename], {cwd: ctx.moduleRoot});
        textureCount += 1;
        totalBytes += data.length;
      }
      const tierDirectory = path.join(ctx.outputRoot, configuredLevel.slug, configuredTier.id);
      const actualFiles = (await readdir(tierDirectory, {withFileTypes: true}))
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort();
      assert.deepEqual(actualFiles, expectedFiles.sort(), `${configuredLevel.name} ${configuredTier.id} contains unmanifested files.`);
    }
  }

  const thumbnailPath = assetFilename(ctx, manifest.thumbnail.path);
  assert.ok(thumbnailPath, "Thumbnail path is not inside the content module.");
  const thumbnail = await sharp(thumbnailPath).metadata();
  assert.equal(thumbnail.width, manifest.thumbnail.width, "Thumbnail width differs.");
  assert.equal(thumbnail.height, manifest.thumbnail.height, "Thumbnail height differs.");
  assert.equal(await sha256File(thumbnailPath), manifest.thumbnail.sha256, "Thumbnail hash differs.");
  console.log(`Verified ${textureCount} KTX2 textures, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB total.`);
}

async function main() {
  const ctx = await createContext();
  if (ctx.command === "doctor") return doctor(ctx);
  if (ctx.command === "rebuild") return rebuild(ctx);
  if (ctx.command === "verify") return verify(ctx);
  throw new Error(USAGE);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

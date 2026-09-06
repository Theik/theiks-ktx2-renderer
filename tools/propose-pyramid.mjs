import {readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

import {createTileLayout, preferredGutter, resolveTierGutter} from "./pyramid-lib.mjs";

export {preferredGutter};

export const USAGE = `Usage: node tools/propose-pyramid.mjs --scene <scene.json> [--masters <dir>] [--out <pyramid.json>]
   or: --width --height --grid-size [--padding] [--master-grid-size] [--master-width] [--master-height]
       [--level id:name:slug:file.webp]... [--masters <dir>] [--out <pyramid.json>]`;

export const ENCODER = {
  name: "KTX-Software",
  version: "4.4.2",
  primaryEncoding: "uastc",
  mipLevels: 1,
  minimumSsim: 0.96,
  uastcQuality: 2,
  zstdLevel: 18
};

export function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replaceAll(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replaceAll(/[_\s]+/g, "-")
    .replaceAll(/-+/g, "-");
}

export function parseCli(argv) {
  const flags = new Map();
  const levels = [];
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = args[index + 1];
    if (name === "level") {
      if (!value || value.startsWith("--")) throw new Error(`--level requires id:name:slug:filename.\n${USAGE}`);
      levels.push(value);
      index += 1;
      continue;
    }
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.\n${USAGE}`);
    flags.set(name, value);
    index += 1;
  }
  return {flags, levels};
}

export function pickGridPixels(gridSize, masterGridSize) {
  const z0 = Number.isInteger(gridSize / 2) ? gridSize / 2 : gridSize;
  return {z0, z1: gridSize, z2: masterGridSize};
}

function integerSourceGutters(gridPixels, masterGridSize, max = 16) {
  const scale = gridPixels / masterGridSize;
  const gutters = [];
  for (let gutter = 1; gutter <= max; gutter += 1) {
    if (Number.isInteger(gutter / scale)) gutters.push(gutter);
  }
  if (!gutters.length) throw new Error(`No gutter maps ${gridPixels} px/cell back to whole master pixels at ${masterGridSize} px/cell.`);
  return gutters;
}

function physicalSize(cells, gridPixels, gutter) {
  return cells * gridPixels + (2 * gutter);
}

function tileFits(cells, gridPixels, gutter) {
  if (cells < 1) return false;
  const physical = physicalSize(cells, gridPixels, gutter);
  return physical < 4096 && physical % 4 === 0;
}

export function splitDimension(totalCells, gridPixels, gutter) {
  if (!Number.isInteger(totalCells) || totalCells < 1) {
    throw new Error(`Cell count must be a positive integer, found ${totalCells}.`);
  }
  let maxCells = 0;
  for (let cells = 1; cells <= totalCells; cells += 1) {
    if (tileFits(cells, gridPixels, gutter)) maxCells = cells;
  }
  if (!maxCells) {
    throw new Error(`No ${gridPixels} px/cell tile with gutter ${gutter} stays under 4096 and 4x4 aligned.`);
  }

  const minParts = Math.ceil(totalCells / maxCells);
  for (let parts = minParts; parts <= totalCells; parts += 1) {
    const base = Math.floor(totalCells / parts);
    const extra = totalCells % parts;
    const even = Array.from({length: parts}, (_, index) => base + (index < extra ? 1 : 0));
    if (even.every(cells => tileFits(cells, gridPixels, gutter))) return even;
  }
  throw new Error(`Could not split ${totalCells} cells at ${gridPixels} px/cell into equal 4x4-aligned tiles.`);
}

function layoutScore(columns, rows, gutter, preferred) {
  const tileCount = columns.length * rows.length;
  const spread = (Math.max(...columns) - Math.min(...columns)) + (Math.max(...rows) - Math.min(...rows));
  const distance = Math.abs(gutter - preferred);
  return [tileCount, spread, distance, gutter];
}

function betterScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

export function proposeTier(id, sceneColumns, sceneRows, gridPixels, masterGridSize) {
  const preferred = preferredGutter(gridPixels, masterGridSize);
  let best;
  for (const gutter of integerSourceGutters(gridPixels, masterGridSize)) {
    let columns;
    let rows;
    try {
      columns = splitDimension(sceneColumns, gridPixels, gutter);
      rows = splitDimension(sceneRows, gridPixels, gutter);
    } catch {
      continue;
    }
    const candidate = {
      id,
      gridPixels,
      columns,
      rows,
      gutter,
      score: layoutScore(columns, rows, gutter, preferred)
    };
    if (!best || betterScore(candidate.score, best.score)) best = candidate;
  }
  if (!best) {
    throw new Error(`No ${id} gutter can tile ${sceneColumns}x${sceneRows} cells at ${gridPixels} px/cell.`);
  }
  const tier = {id: best.id, gridPixels: best.gridPixels, columns: best.columns, rows: best.rows};
  resolveTierGutter({scene: {masterGridSize}}, tier);
  return tier;
}

export function proposeTiers(sceneColumns, sceneRows, gridSize, masterGridSize) {
  const pixels = pickGridPixels(gridSize, masterGridSize);
  return ["z0", "z1", "z2"].map(id => proposeTier(id, sceneColumns, sceneRows, pixels[id], masterGridSize));
}

export function validateProposedConfig(config) {
  const sceneColumns = config.scene.width / config.scene.gridSize;
  const sceneRows = config.scene.height / config.scene.gridSize;
  if (!Number.isInteger(sceneColumns) || !Number.isInteger(sceneRows)) {
    throw new Error("Scene width and height must be divisible by gridSize.");
  }
  if (config.scene.masterWidth !== sceneColumns * config.scene.masterGridSize) {
    throw new Error("masterWidth must equal (width / gridSize) × masterGridSize.");
  }
  if (config.scene.masterHeight !== sceneRows * config.scene.masterGridSize) {
    throw new Error("masterHeight must equal (height / gridSize) × masterGridSize.");
  }
  for (const tier of config.tiers) {
    for (const tile of createTileLayout(config, tier)) {
      if (tile.pixel.width >= 4096 || tile.pixel.height >= 4096) {
        throw new Error(`${tier.id}/${tile.id} exceeds the 4096-pixel safety limit.`);
      }
      if ((tile.pixel.width % 4) || (tile.pixel.height % 4)) {
        throw new Error(`${tier.id}/${tile.id} is not aligned to 4x4 GPU compression blocks.`);
      }
    }
  }
  return config;
}

export function sceneLevels(scene) {
  const levels = scene.levels ?? [];
  return levels.map((level, index) => {
    const name = level.name || `Level ${index + 1}`;
    const slug = slugify(name) || `level-${index + 1}`;
    return {
      id: level._id || level.id || `level-${String(index + 1).padStart(4, "0")}`,
      name,
      slug,
      master: `${slug}.webp`
    };
  });
}

export function parseLevelFlag(value) {
  const [id, name, slug, master] = String(value).split(":");
  if (!id || !name || !slug || !master) throw new Error(`Invalid --level ${value}. Use id:name:slug:filename.webp.`);
  return {id, name, slug, master};
}

export function parseSceneDocument(raw) {
  const scene = Array.isArray(raw) ? raw.find(entry => entry?.width && entry?.height) ?? raw[0] : raw;
  if (!scene || typeof scene !== "object") throw new Error("Scene JSON did not contain a Scene document.");
  const gridSize = scene.grid?.size ?? scene.gridSize ?? scene.grid;
  if (!Number.isFinite(Number(gridSize))) throw new Error("Scene is missing grid.size.");
  return {
    width: scene.width,
    height: scene.height,
    gridSize: Number(gridSize),
    padding: scene.padding,
    levels: sceneLevels(scene)
  };
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || slug;
}

export function levelsFromMasterNames(names) {
  return names.map((name, index) => {
    const slug = slugify(path.parse(name).name) || `level-${index + 1}`;
    return {id: slug, name: titleFromSlug(slug), slug, master: name};
  });
}

export async function inspectMasters(mastersDir, expectedNames) {
  const sharp = (await import("sharp")).default;
  const entries = (await readdir(mastersDir)).filter(name => name.toLowerCase().endsWith(".webp"));
  const byLower = new Map(entries.map(name => [name.toLowerCase(), name]));
  const wanted = expectedNames?.length ? expectedNames : entries;
  if (!wanted.length) throw new Error(`No .webp masters in ${mastersDir}.`);
  const inspected = [];
  for (const name of wanted) {
    const filename = byLower.get(path.basename(name).toLowerCase());
    if (!filename) throw new Error(`Missing master ${path.basename(name)} in ${mastersDir}.`);
    const metadata = await sharp(path.join(mastersDir, filename)).metadata();
    inspected.push({
      name: filename,
      width: metadata.width,
      height: metadata.height,
      channels: metadata.channels,
      hasAlpha: metadata.hasAlpha
    });
  }
  const first = inspected[0];
  for (const master of inspected) {
    if (master.width !== first.width || master.height !== first.height) {
      throw new Error(`${master.name}: ${master.width}x${master.height} does not match ${first.name} ${first.width}x${first.height}.`);
    }
    if (master.channels !== 4 || !master.hasAlpha) throw new Error(`${master.name}: master must be RGBA.`);
  }
  return inspected;
}

export function proposeConfig(input) {
  const gridSize = Number(input.gridSize);
  const width = Number(input.width);
  const height = Number(input.height);
  const padding = Number(input.padding ?? 0.25);
  const sceneColumns = width / gridSize;
  const sceneRows = height / gridSize;
  if (!Number.isInteger(sceneColumns) || !Number.isInteger(sceneRows)) {
    throw new Error("Scene width and height must be divisible by gridSize.");
  }
  const masterGridSize = Number(input.masterGridSize ?? (gridSize * 2));
  if (!Number.isInteger(masterGridSize) || masterGridSize < 1) {
    throw new Error("masterGridSize must be a positive integer.");
  }
  const masterWidth = Number(input.masterWidth ?? (sceneColumns * masterGridSize));
  const masterHeight = Number(input.masterHeight ?? (sceneRows * masterGridSize));
  const levels = input.levels?.length
    ? input.levels
    : [{id: "level-one", name: "Level One", slug: "level-one", master: "level-one.webp"}];

  return validateProposedConfig({
    schemaVersion: 1,
    scene: {
      width,
      height,
      padding,
      gridSize,
      masterWidth,
      masterHeight,
      masterGridSize
    },
    encoder: ENCODER,
    tiers: proposeTiers(sceneColumns, sceneRows, gridSize, masterGridSize),
    levels
  });
}

function applyMasterMeasurements(input, masters, columns, rows) {
  input.masterWidth = masters[0].width;
  input.masterHeight = masters[0].height;
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new Error("Scene width must be divisible by gridSize before masters can be measured.");
  }
  if (!Number.isInteger(rows) || rows <= 0) {
    throw new Error("Scene height must be divisible by gridSize before masters can be measured.");
  }
  input.masterGridSize = masters[0].width / columns;
  if (!Number.isInteger(input.masterGridSize)) {
    throw new Error(`Master width ${masters[0].width} is not divisible by ${columns} scene columns.`);
  }
  if (masters[0].height / rows !== input.masterGridSize) {
    throw new Error("Master height does not use the same pixels-per-cell as master width.");
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const base = path.basename(entry);
  return base === "propose-pyramid.mjs" || base === "propose-pyramid";
}

export async function buildProposedConfig({flags, levels}) {
  let input = {};
  if (flags.get("scene")) {
    const raw = JSON.parse(await readFile(path.resolve(flags.get("scene")), "utf8"));
    input = parseSceneDocument(raw);
  } else {
    if (!flags.get("width") || !flags.get("height") || !flags.get("grid-size")) throw new Error(USAGE);
    input = {
      width: flags.get("width"),
      height: flags.get("height"),
      gridSize: flags.get("grid-size"),
      padding: flags.get("padding"),
      masterGridSize: flags.get("master-grid-size"),
      masterWidth: flags.get("master-width"),
      masterHeight: flags.get("master-height"),
      levels: levels.map(parseLevelFlag)
    };
  }

  if (flags.get("masters")) {
    const columns = Number(input.width) / Number(input.gridSize);
    const rows = Number(input.height) / Number(input.gridSize);
    const expected = input.levels?.length ? input.levels.map(level => level.master) : undefined;
    const masters = await inspectMasters(path.resolve(flags.get("masters")), expected);
    applyMasterMeasurements(input, masters, columns, rows);
    if (!input.levels?.length) input.levels = levelsFromMasterNames(masters.map(master => master.name));
  }

  return proposeConfig(input);
}

async function main() {
  const parsed = parseCli(process.argv);
  const config = await buildProposedConfig(parsed);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const outPath = parsed.flags.get("out");
  if (outPath) {
    await writeFile(path.resolve(outPath), serialized, "utf8");
    console.log(`Wrote ${outPath}`);
  } else process.stdout.write(serialized);

  for (const tier of config.tiers) {
    const tiles = createTileLayout(config, tier);
    const gutter = resolveTierGutter(config, tier);
    const max = Math.max(...tiles.map(tile => Math.max(tile.pixel.width, tile.pixel.height)));
    console.error(`${tier.id}: ${tiles.length} tiles, derived gutter ${gutter}, max ${max} px`);
  }
}

if (isMainModule()) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

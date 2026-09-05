import {createHash} from "node:crypto";
import {access, readFile, stat} from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";

export {
  ByteLruCache,
  canvasRectToSceneRect,
  rectanglesIntersect,
  resolveNativeLevelId,
  RequestGeneration,
  scenePointToCanvasPoint,
  selectLod,
  selectVisibleTiles,
  StaleRequestError,
  levelBottomElevation,
  orderedVisibleLevelIds,
  visibleSceneLevelIds
} from "../scripts/map-pyramid-utils.js";

export const KTX2_IDENTIFIER = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a
]);

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function cumulativeOffsets(values) {
  const offsets = [];
  let offset = 0;
  for (const value of values) {
    offsets.push(offset);
    offset += value;
  }
  return offsets;
}

export function expectedMipCount(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export function createTileLayout(config, tier) {
  const sceneColumns = config.scene.width / config.scene.gridSize;
  const sceneRows = config.scene.height / config.scene.gridSize;
  if (sum(tier.columns) !== sceneColumns || sum(tier.rows) !== sceneRows) {
    throw new Error(`${tier.id}: grid partition does not cover ${sceneColumns}x${sceneRows} cells.`);
  }

  const columnOffsets = cumulativeOffsets(tier.columns);
  const rowOffsets = cumulativeOffsets(tier.rows);
  const sourceScale = config.scene.masterGridSize;
  const outputScale = tier.gridPixels / sourceScale;
  const sourceGutter = tier.gutter / outputScale;
  if (!Number.isInteger(sourceGutter)) {
    throw new Error(`${tier.id}: gutter ${tier.gutter} does not map to whole master pixels.`);
  }

  const tiles = [];
  for (let row = 0; row < tier.rows.length; row += 1) {
    for (let column = 0; column < tier.columns.length; column += 1) {
      const gridX = columnOffsets[column];
      const gridY = rowOffsets[row];
      const gridWidth = tier.columns[column];
      const gridHeight = tier.rows[row];
      const sourceX = gridX * sourceScale;
      const sourceY = gridY * sourceScale;
      const sourceWidth = gridWidth * sourceScale;
      const sourceHeight = gridHeight * sourceScale;
      const cropX = Math.max(0, sourceX - sourceGutter);
      const cropY = Math.max(0, sourceY - sourceGutter);
      const cropRight = Math.min(config.scene.masterWidth, sourceX + sourceWidth + sourceGutter);
      const cropBottom = Math.min(config.scene.masterHeight, sourceY + sourceHeight + sourceGutter);
      const leftPad = sourceX === 0 ? tier.gutter : 0;
      const topPad = sourceY === 0 ? tier.gutter : 0;
      const rightPad = sourceX + sourceWidth === config.scene.masterWidth ? tier.gutter : 0;
      const bottomPad = sourceY + sourceHeight === config.scene.masterHeight ? tier.gutter : 0;
      const contentWidth = gridWidth * tier.gridPixels;
      const contentHeight = gridHeight * tier.gridPixels;

      tiles.push({
        id: `${row}-${column}`,
        row,
        column,
        grid: {x: gridX, y: gridY, width: gridWidth, height: gridHeight},
        scene: {
          x: gridX * config.scene.gridSize,
          y: gridY * config.scene.gridSize,
          width: gridWidth * config.scene.gridSize,
          height: gridHeight * config.scene.gridSize
        },
        source: {
          x: sourceX,
          y: sourceY,
          width: sourceWidth,
          height: sourceHeight,
          cropX,
          cropY,
          cropWidth: cropRight - cropX,
          cropHeight: cropBottom - cropY
        },
        resize: {
          width: Math.round((cropRight - cropX) * outputScale),
          height: Math.round((cropBottom - cropY) * outputScale)
        },
        extend: {left: leftPad, top: topPad, right: rightPad, bottom: bottomPad},
        frame: {x: tier.gutter, y: tier.gutter, width: contentWidth, height: contentHeight},
        pixel: {
          width: contentWidth + (2 * tier.gutter),
          height: contentHeight + (2 * tier.gutter)
        }
      });
    }
  }
  return tiles;
}

export function premultiplyRgba(data) {
  if ((data.length % 4) !== 0) throw new Error("RGBA data length must be divisible by four.");
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] / 255;
    data[offset] = Math.round(data[offset] * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * alpha);
  }
  return data;
}

export async function sha256File(filename) {
  const data = await readFile(filename);
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function readKtx2Header(buffer) {
  if (buffer.length < 80 || !buffer.subarray(0, 12).equals(KTX2_IDENTIFIER)) {
    throw new Error("Invalid KTX2 identifier.");
  }
  const dfdByteOffset = buffer.readUInt32LE(48);
  if ((dfdByteOffset + 16) > buffer.length) throw new Error("Invalid KTX2 DFD offset.");
  return {
    vkFormat: buffer.readUInt32LE(12),
    typeSize: buffer.readUInt32LE(16),
    width: buffer.readUInt32LE(20),
    height: buffer.readUInt32LE(24),
    depth: buffer.readUInt32LE(28),
    layers: buffer.readUInt32LE(32),
    faces: buffer.readUInt32LE(36),
    levels: buffer.readUInt32LE(40),
    supercompression: buffer.readUInt32LE(44),
    dfdByteOffset,
    premultipliedAlpha: (buffer[dfdByteOffset + 15] & 1) === 1
  };
}

export function markKtxPremultiplied(buffer) {
  const header = readKtx2Header(buffer);
  buffer[header.dfdByteOffset + 15] |= 1;
  return buffer;
}

export function parseOverallSsim(output) {
  const match = output.match(/SSIM Avg R:\s*[+]?(\d+(?:\.\d+)?),\s*G:\s*[+]?(\d+(?:\.\d+)?),\s*B:\s*[+]?(\d+(?:\.\d+)?),\s*A:\s*[+]?(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const channels = match.slice(1).map(Number);
  return {channels, minimum: Math.min(...channels), average: channels.reduce((a, b) => a + b, 0) / channels.length};
}

export async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env ?? process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      const output = `${stdout}${stderr}`;
      if (code === 0) resolve({code, stdout, stderr, output});
      else reject(new Error(`${path.basename(command)} ${args[0] ?? ""} exited with ${code}.\n${output}`));
    });
  });
}

export async function fileSize(filename) {
  return (await stat(filename)).size;
}

export function posixJoin(...parts) {
  return parts
    .filter(Boolean)
    .map(part => String(part).replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function masterFilename(level) {
  return path.basename(String(level.master ?? "").replaceAll("\\", "/"));
}

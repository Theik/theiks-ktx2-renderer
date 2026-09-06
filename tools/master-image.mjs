import path from "node:path";

import sharp from "sharp";

export function supportedMasterSuffixes() {
  return [...new Set(
    Object.values(sharp.format)
      .filter(format => format.input?.file)
      .flatMap(format => format.input.fileSuffix ?? [])
      .map(suffix => suffix.toLowerCase())
  )].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export function masterSuffix(filename) {
  const lower = String(filename).toLowerCase();
  return supportedMasterSuffixes().find(suffix => lower.endsWith(suffix));
}

export function isSupportedMasterFilename(filename) {
  return Boolean(masterSuffix(filename));
}

export function masterStem(filename) {
  const basename = path.basename(String(filename));
  const suffix = masterSuffix(basename);
  return suffix ? basename.slice(0, -suffix.length) : path.parse(basename).name;
}

export function validateMasterMetadata(filename, metadata) {
  const basename = path.basename(filename);
  if (!metadata.width || !metadata.height) {
    throw new Error(`${basename}: Sharp could not determine the image dimensions.`);
  }
  if (Number(metadata.pages ?? 1) !== 1) {
    throw new Error(`${basename}: animated and multi-page master images are not supported.`);
  }
  return metadata;
}

export async function inspectMasterImage(filename) {
  const metadata = await sharp(filename, {limitInputPixels: false}).metadata();
  return validateMasterMetadata(filename, metadata);
}

export function normalizedMasterPipeline(filename) {
  return sharp(filename, {limitInputPixels: false})
    .toColourspace("srgb")
    .ensureAlpha();
}

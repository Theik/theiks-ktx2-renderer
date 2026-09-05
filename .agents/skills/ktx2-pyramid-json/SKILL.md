---
name: ktx2-pyramid-json
description: >-
  Prepares a pyramid.json for Theik's KTX2 Renderer from a Foundry Scene and RGBA WebP masters. Use when creating a map-module pyramid config, generating pyramid.json, choosing z0/z1/z2 columns rows and gutters, or when a map developer asks to author a KTX2 pyramid layout from scene size and masters.
---

# Prepare pyramid.json

Author `pyramid.json` only. Do not rebuild KTX2, call `ktx`, or invent encoder settings unless the user asks for a rebuild after the config exists.

The encoder and 4×4 layout math live in this renderer. Run `tools/propose-pyramid.mjs`. Do not hand-edit `columns`, `rows`, `gutter`, or `gridPixels` unless `doctor` fails afterward.

## Renderer root

Resolve the renderer from, in order:

1. This repository, if the workspace is `theiks-ktx2-renderer`
2. `KTX2_RENDERER_ROOT`
3. Sibling `../theiks-ktx2-renderer`

All commands below are from that root.

## Inputs

Do not run the proposer until the user has named three paths:

1. `--scene` (exported Foundry Scene JSON) **or** `--width`, `--height`, `--grid-size`
2. `--masters` (directory of RGBA `.webp` files), unless they only have sizes and no files yet
3. `--out` (where to write `pyramid.json` in the **content** module)

If they pasted a prompt with "this Scene" / "these masters" and no paths, ask for those three. Do not invent them. Do not use this repo's `examples/pyramid.json` as their map. Do not search the whole disk.

## Workflow

1. Open the Scene JSON (`width`, `height`, `grid.size`, `padding`, `levels`) and the RGBA WebP masters directory. Masters are usually `2 × gridSize` pixels per cell. Scene width and height must divide by `gridSize`.
2. Choose an `--out` path in the **content** module, typically `tools/maps/your-pyramid.json`. Do not write into `examples/pyramid.json` unless the user is changing this repo's sample.
3. Generate the config:

   ```text
   node tools/propose-pyramid.mjs --scene <scene.json> --masters <masters-dir> --out <pyramid.json>
   ```

   Without a Scene file:

   ```text
   node tools/propose-pyramid.mjs --width <px> --height <px> --grid-size <px> \
     --masters <masters-dir> --out <pyramid.json> \
     --level <id>:<name>:<slug>:<filename.webp>
   ```

   Repeat `--level` once per floor. Omit `--masters` only when the user has sizes but no files yet (`masterGridSize` then defaults to `2 × gridSize`).
4. If masters exist, run doctor next. Stop on failure.

   ```text
   node tools/pyramid.mjs doctor --config <pyramid.json> --masters <masters-dir> \
     --output <ktx2-output-dir> --module-id <foundryModuleId>
   ```

5. Show the user the written path, cell counts, and each tier's tile count / gutter / max pixel size from the proposer stderr. Copy the `encoder` object as emitted. Do not change `mipLevels`, `primaryEncoding`, `uastcQuality`, or `zstdLevel`.
6. Stop. Rebuild with `tools/pyramid.mjs rebuild` only when the user asks.

## Guardrails

- `levels[].master` is a filename in `--masters` (`ground-floor.webp`), not a module path.
- Keep `schemaVersion: 1` and three tiers `z0`, `z1`, `z2`.
- Physical tile size is `(cells × gridPixels) + (2 × gutter)`. It must stay **under 4096** and **divisible by 4**. The proposer already enforces that through `createTileLayout`.
- Encoding rules (KTX-Software 4.4.2, UASTC, one mip, Sharp premultiply + DFD flag, never RGBA8) stay in the renderer. Do not fork them into the map module.
- If `doctor` reports a 4×4 or master-dimension error, fix Scene size, master size, or re-run the proposer. Do not patch a single gutter by guesswork.

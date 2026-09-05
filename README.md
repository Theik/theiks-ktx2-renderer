<a id="readme-top"></a>

<div align="center">
  <img src="https://raw.githubusercontent.com/Theik/theiks-toolbag/main/assets/images/tabletop-by-theik-logo.png" alt="Tabletop by Theik" width="420">

  <h1>Theik's KTX2 Renderer</h1>

  <p>
    <strong>Stream battle maps from a KTX2 pyramid.</strong><br>
    A Foundry Virtual Tabletop module that loads only the tiles needed for the current floor and zoom, plus a CLI that builds those pyramids from high-resolution masters.
  </p>

  <p>
    <a href="https://github.com/Theik/theiks-ktx2-renderer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Theik/theiks-ktx2-renderer?style=for-the-badge&sort=semver&color=C78F46"></a>
    <a href="https://foundryvtt.com/"><img alt="Foundry VTT 14" src="https://img.shields.io/badge/Foundry_VTT-14-7A4A35?style=for-the-badge"></a>
    <a href="https://github.com/Theik/theiks-ktx2-renderer/releases"><img alt="Total downloads" src="https://img.shields.io/github/downloads/Theik/theiks-ktx2-renderer/total?style=for-the-badge&color=315949"></a>
    <a href="https://github.com/Theik/theiks-ktx2-renderer/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/Theik/theiks-ktx2-renderer?style=for-the-badge&color=6D597A"></a>
    <a href="https://www.patreon.com/cw/TabletopByTheik"><img alt="Support Tabletop by Theik on Patreon" src="https://img.shields.io/badge/Patreon-Support-FF424D?style=for-the-badge&logo=patreon&logoColor=white"></a>
  </p>

  <p>
    <a href="#whats-in-it">What's in it</a>
    ·
    <a href="#quick-start">Quick start</a>
    ·
    <a href="#release-your-own-map-module">Release a map</a>
    ·
    <a href="#prepare-pyramidjson">Prepare pyramid.json</a>
    ·
    <a href="#encoding-rules">Encoding rules</a>
    ·
    <a href="#installation">Installation</a>
  </p>
</div>

> [!IMPORTANT]
> Theik's KTX2 Renderer is built and tested for **Foundry Virtual Tabletop v14**. Map modules ship the generated textures. This module is the engine that streams them.

## What's in it

<table>
  <tr>
    <td width="50%">
      <h3>Runtime LOD streaming</h3>
      Any Scene flagged with <code>flags.theiks-ktx2-renderer.mapPyramid</code> loads a z0 / z1 / z2 KTX2 pyramid. Foundry only transcodes the tiles needed for the current level and viewport.
    </td>
    <td width="50%">
      <h3>Authoring CLI</h3>
      <code>node tools/pyramid.mjs</code> turns RGBA WebP masters into UASTC KTX2 tiles, a manifest, and a thumbnail. The Foundry zip includes <code>tools/</code> so map makers who installed from Foundry still have the CLI on disk.
    </td>
  </tr>
</table>

## Quick start

1. In Foundry, open **Add-on Modules → Install Module**.
2. Paste the [latest manifest URL](https://github.com/Theik/theiks-ktx2-renderer/releases/latest/download/module.json) into **Manifest URL** and select **Install**.
3. Enable **Theik's KTX2 Renderer** from **Manage Modules** in your world.
4. Enable any map module that lists this renderer as a required dependency.
5. Optionally open **Game Settings → Theik's KTX2 Renderer** and set **Map detail** to Auto, Low, Medium, or High for this browser.

If a flagged Scene cannot stream, the GM sees an error naming the Scene. Native Foundry backgrounds remain as a fallback only after that message.

## Release your own map module

Map modules ship textures. This renderer ships the engine. Do not copy the encoder into the content repo.

1. Declare a Foundry dependency on `theiks-ktx2-renderer` in your `module.json`:

   ```json
   "relationships": {
     "requires": [
       {
         "id": "theiks-ktx2-renderer",
         "type": "module",
         "compatibility": { "minimum": "1.0.0" }
       }
     ]
   }
   ```

2. Export **RGBA WebP masters** at `masterGridSize` pixels per cell. That is usually **twice** the Foundry grid size, so a 100 px grid uses 200 px/cell masters and a 150 px grid uses 300 px/cell masters. Scene width and height must be divisible by `gridSize`. Master width and height must be divisible by `masterGridSize`. Keep masters local. Commit generated KTX2, not the WebPs.

3. Prepare a `pyramid.json`. Run the proposer in [Prepare pyramid.json](#prepare-pyramidjson), or copy the shape from [`examples/pyramid.json`](examples/pyramid.json).

   Split each tier with `columns` and `rows` so they **sum to the scene's cell count** (`width / gridSize` and `height / gridSize`). Pick `gridPixels` and `gutter` so every tile's **physical** size stays **under 4096 px** and **divisible by 4** (see [Why tiles must be 4×4](#why-tiles-must-be-4x4)):

   `physical = (cells in that tile × gridPixels) + (2 × gutter)`

   The extra gutter pixels are duplicated edge samples. They pad the GPU texture to a 4×4 size without changing the content the mesh samples, and they keep block compression from smearing across tile borders. The gutter must also map back to a whole number of master pixels (`gutter / (gridPixels / masterGridSize)`). `npm run pyramid -- doctor` refuses layouts that break those rules.

4. Install Node.js 24+, run `npm install` in the renderer folder, and install **KTX-Software 4.4.2**. Put `ktx` on `PATH`, set `KTX_CLI`, or install under `.tools/ktx`.

5. Rebuild from the content module directory, or pass `--module-root`:

   ```text
   node ../theiks-ktx2-renderer/tools/pyramid.mjs rebuild \
     --config tools/maps/your-pyramid.json \
     --masters assets/masters \
     --output assets/maps/your-pyramid \
     --module-id your-module-id
   ```

   `--masters` resolves each level's `master` filename (`level-one.webp` → `<masters>/level-one.webp`). `--output` receives `z0` / `z1` / `z2` folders, `manifest.json`, and `thumb.webp`. `--module-id` prefixes Foundry paths as `modules/<id>/…`.

6. Set each Level background to its **z0** tile. Set the Scene flag:

   ```json
   "flags": {
     "theiks-ktx2-renderer": {
       "mapPyramid": {
         "version": 1,
         "manifest": "modules/your-module-id/assets/maps/your-pyramid/manifest.json"
       }
     }
   }
   ```

   `version` is diagnostics only. The renderer does not skip a Scene because the number is missing or newer.

7. Commit the generated KTX2 files and manifest. Ship the content module. Players need this renderer enabled beside it.

Useful commands:

```text
node tools/propose-pyramid.mjs --scene … --masters … --out …
node tools/pyramid.mjs doctor --config … --masters … --output … --module-id …
node tools/pyramid.mjs rebuild --config … --masters … --output … --module-id … --levels all
node tools/pyramid.mjs rebuild --config … --masters … --output … --module-id … --levels level-one --tiers z0
node tools/pyramid.mjs verify --config … --masters … --output … --module-id … [--runtime-only]
```

`verify` checks generated KTX2 files and the manifest. Scene wall counts, tile counts, and other document invariants belong in the content module.

## Prepare pyramid.json

Picking `columns` by hand is how tiles go black. A gutter off by one pixel fails 4×4 alignment, and Foundry's GPU upload then draws nothing. The proposer needs file paths. "This scene" is not a path.

### CLI

From the renderer folder, point `--scene`, `--masters`, and `--out` at **your** map module:

```text
node tools/propose-pyramid.mjs \
  --scene ../your-map-module/packs/maps/MyDungeon.json \
  --masters ../your-map-module/assets/masters \
  --out ../your-map-module/tools/maps/my-dungeon-pyramid.json
```

`npm run pyramid:propose --` takes the same flags. Without a Scene file, pass `--width`, `--height`, `--grid-size`, and one `--level id:name:slug:file.webp` per floor. The proposer copies this repo's encoder block. Leave `mipLevels: 1` and `primaryEncoding: "uastc"` alone.

### Cursor skill

The skill is `.agents/skills/ktx2-pyramid-json` in git and in the Foundry zip. Cursor loads it only if that folder is inside an **open workspace folder**. Copy it into the map repo's `.agents/skills/`, or add this renderer as a workspace folder.

Type the Scene JSON path, the masters directory, and the output file. Paste something like this, with your paths:

```text
$ktx2-pyramid-json
Scene JSON: packs/maps/MyDungeon.json
Masters: assets/masters
Write: tools/maps/my-dungeon-pyramid.json
Do not rebuild KTX2.
```

The agent runs `tools/propose-pyramid.mjs` and then `doctor` if the masters exist. It does not rebuild unless you ask.

## Encoding rules

These are load-bearing. Wrong mip counts or unaligned sizes are what produce black tiles.

- KTX-Software CLI **exactly 4.4.2**. Foundry 14 transcodes UASTC to BC7 on common GPUs.
- Every tile is **UASTC + Zstd**, **one mip level** (`mipLevels: 1`). Never `--generate-mipmap`, never a mip chain.
- Every physical texture size must be **aligned to 4×4**. If content pixels are not already a multiple of 4, increase the gutter until the physical size is.
- Premultiply RGBA in Sharp, then set the KTX2 DFD premultiplied-alpha flag after `ktx create`. Version 4.4.2 cannot set that flag itself.
- Keep UASTC when SSIM falls below 0.96. **Never** fall back to uncompressed `R8G8B8A8_SRGB` / `rgba8-zstd`; Foundry's KTX2 loader rejects it (`Invalid Asset`).
- Tiles stay under 4096 px and under GitHub's 95 MiB file limit.

The CLI is the encoder. Do not call `ktx create` by hand.

### Why tiles must be 4×4

UASTC (and the BC7 format Foundry transcodes it to) compresses the image in **4×4 pixel blocks**. The GPU cannot upload a block-compressed texture whose width or height is 1, 2, or 3 pixels off a multiple of 4. Drivers then log `GL_INVALID_OPERATION: Invalid compressed image size` and the tile draws black.

The mesh still uses the inner content rectangle. Gutter is only there so the file on disk is a valid compressed texture. A 100×50 content tile needs a physical size such as 100×52, not 100×50.

Keep **one mip**. Each mipmap level must also be 4×4 aligned. A mip chain on a size that is not a multiple of 4 will fail. Zoom uses the z0 / z1 / z2 pyramid instead.

## Installation

### Foundry module browser

In Foundry, open **Add-on Modules → Install Module** and paste:

```text
https://github.com/Theik/theiks-ktx2-renderer/releases/latest/download/module.json
```

### Development installation

Clone this repository into Foundry's `Data/modules/theiks-ktx2-renderer` directory, run `npm install`, restart Foundry, and enable **Theik's KTX2 Renderer** from **Manage Modules** in your world.

## License, credits, and legal

<div>
  <p>
    <strong>Code:</strong> Original module code and documentation are released under the <a href="LICENSE">MIT License</a>.
  </p>
  <p>
    <strong>Encoding:</strong> Pyramid tiles are built with <a href="https://github.com/KhronosGroup/KTX-Software">KTX-Software</a> from The Khronos Group.
  </p>
  <p>
    <strong>Development:</strong> <a href="https://openai.com/chatgpt/overview/">ChatGPT</a> by OpenAI and <a href="https://cursor.com/">Cursor</a> were used as programming assistants.
  </p>
</div>

The MIT License does **not** cover third-party software, names, or trademarks. Those remain subject to their respective owners' terms. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for the complete attribution and license-scope details.

Theik's KTX2 Renderer is an independent package for use with a licensed copy of Foundry Virtual Tabletop. It is not affiliated with or endorsed by Foundry Gaming LLC, The Khronos Group, OpenAI, or Anysphere. Foundry Virtual Tabletop and all other third-party names and trademarks belong to their respective owners.

---

<div align="center">
  <img src="https://raw.githubusercontent.com/Theik/theiks-toolbag/main/assets/images/tabletop-by-theik-logo.png" alt="Tabletop by Theik" width="180">

  <p><strong>Built by <a href="https://github.com/Theik">Theik</a> for adventurous tables.</strong></p>
  <p>
    <a href="https://github.com/Theik/theiks-ktx2-renderer/releases">Releases</a>
    ·
    <a href="https://github.com/Theik/theiks-ktx2-renderer/issues">Report an issue</a>
    ·
    <a href="https://www.patreon.com/cw/TabletopByTheik">Support on Patreon</a>
    ·
    <a href="#readme-top">Back to top ↑</a>
  </p>
</div>

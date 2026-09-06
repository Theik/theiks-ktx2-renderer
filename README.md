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
    <a href="#build-or-update-your-own-map-module">Build a map module</a>
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

## Build or update your own map module

Follow these steps in order. The tools calculate the tile sizes and overlap for you. Do not calculate or edit `columns`, `rows`, `gridPixels`, or `gutter` yourself.

Already built this map once? Skip to [Updating the map later](#updating-the-map-later).

### 1. Put both modules in the same folder

Open Foundry's User Data folder, then open `Data/modules`. Your folders should look like this:

```text
Data/modules/
├── theiks-ktx2-renderer/
└── MODULE_FOLDER/
```

The commands below use three placeholder names:

| Placeholder | What to use | Example |
| --- | --- | --- |
| `MODULE_FOLDER` | Your map module's folder name | `theiks-harrowstone` |
| `MODULE_ID` | The `id` near the top of your map module's `module.json` | `theiks-harrowstone` |
| `MAP_NAME` | A short name for this map, using lowercase letters and hyphens | `harrowstone` |

Replace every placeholder in a command before running it. `MODULE_FOLDER` and `MODULE_ID` are often the same, but check `module.json` instead of guessing.

### 2. Add the renderer dependency

Open your map module's `module.json`. If it has no `relationships` section, add this at the top level, beside fields such as `id`, `title`, and `version`:

```json
"relationships": {
  "requires": [
    {
      "id": "theiks-ktx2-renderer",
      "type": "module",
      "manifest": "https://github.com/Theik/theiks-ktx2-renderer/releases/latest/download/module.json",
      "compatibility": {
        "minimum": "1.0.0"
      }
    }
  ]
}
```

If `relationships.requires` already exists, keep its other entries and add only the object containing `theiks-ktx2-renderer` as another list item.

### 3. Install the build tools once

1. Install [Node.js](https://nodejs.org/en/download) version 24 or newer.
2. Close and reopen your terminal.
3. Run `node --version`. Continue only if it prints `v24` or a higher number.
4. Open a terminal in `theiks-ktx2-renderer`.
   - On Windows, open the folder in File Explorer, click the address bar, type `powershell`, and press Enter.
   - On macOS or Linux, open Terminal, type `cd ` with a trailing space, drag the renderer folder into the window, and press Enter.
5. Run `npm install`.
6. Download and install **KTX-Software 4.4.2** from the [official 4.4.2 release](https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2).
   - Most Windows PCs need `KTX-Software-4.4.2-Windows-x64.exe`. Use the `arm64` file only for a Windows on ARM computer.
   - Apple Silicon Macs need `Darwin-arm64.pkg`. Intel Macs need `Darwin-x86_64.pkg`.
   - On Linux, choose the `x86_64` or `arm64` package that matches your computer and package manager.
7. Close and reopen the terminal in the renderer folder.
8. Run `ktx --version`. It must print `4.4.2`.

If Windows says that `ktx` is not recognized, the installer normally placed it at `C:\Program Files\KTX-Software\bin\ktx.exe`. Run:

```powershell
[Environment]::SetEnvironmentVariable("KTX_CLI", "C:\Program Files\KTX-Software\bin\ktx.exe", "User")
```

Close PowerShell, open it again in the renderer folder, then check the file:

```powershell
& $env:KTX_CLI --version
```

If that path does not exist, find `ktx.exe` in File Explorer and replace the path in the first command with its real location.

Keep at least 3 GiB of free space on the drive containing your map module.

### 4. Prepare the Scene and map images

In `MODULE_FOLDER`, create these folders if they do not exist:

```text
assets/masters/
assets/maps/
tools/maps/
```

Your module should also have a folder containing the unpacked JSON source for its Scenes. This guide uses `packs-src/maps/`. If your module uses a different folder, use that folder in every `--scene` path below.

Then prepare the inputs:

1. In Foundry, open the Scenes sidebar.
2. Right-click the Scene and choose **Export Data**.
3. Move the downloaded JSON file to `MODULE_FOLDER/packs-src/maps/MAP_NAME.json`.
4. Export one WebP image for every floor in the Scene.
5. Keep transparency enabled when exporting. The files must be RGBA WebPs, which means they contain red, green, blue, and transparency channels.
6. Give every floor image the same width and height. Twice the Scene's pixel width and height is the usual choice.
7. Put the WebPs in `MODULE_FOLDER/assets/masters/`.

Name each WebP after its Foundry Level. Use lowercase letters, replace spaces with hyphens, and remove punctuation:

```text
Ground Floor  → ground-floor.webp
First Floor   → first-floor.webp
Roof          → roof.webp
```

The next command reports the exact missing filename if one does not match.

### 5. Create the map recipe

Stay in the `theiks-ktx2-renderer` terminal. Replace the three placeholders, then run this as one line:

```powershell
node tools/propose-pyramid.mjs --scene "../MODULE_FOLDER/packs-src/maps/MAP_NAME.json" --masters "../MODULE_FOLDER/assets/masters" --out "../MODULE_FOLDER/tools/maps/MAP_NAME-pyramid.json"
```

This creates `MAP_NAME-pyramid.json`. It reads the Scene size, grid size, floors, and WebP dimensions. It also chooses all tile measurements. Do not copy `examples/pyramid.json` over this file.

### 6. Check everything before building

Replace the placeholders and run:

```powershell
node tools/pyramid.mjs doctor --config "../MODULE_FOLDER/tools/maps/MAP_NAME-pyramid.json" --masters "../MODULE_FOLDER/assets/masters" --output "../MODULE_FOLDER/assets/maps/MAP_NAME-pyramid" --module-id "MODULE_ID" --module-root "../MODULE_FOLDER"
```

`doctor` prints the Node, KTX, and image versions it found. It also checks the Scene size, master images, free disk space, and tile layout. Fix any reported error before continuing.

### 7. Build the KTX2 files

The first build must include every floor and quality level:

```powershell
node tools/pyramid.mjs rebuild --config "../MODULE_FOLDER/tools/maps/MAP_NAME-pyramid.json" --masters "../MODULE_FOLDER/assets/masters" --output "../MODULE_FOLDER/assets/maps/MAP_NAME-pyramid" --module-id "MODULE_ID" --module-root "../MODULE_FOLDER" --levels all --tiers all
```

The build writes these files:

```text
assets/maps/MAP_NAME-pyramid/
├── manifest.json
├── thumb.webp
└── one folder per floor, containing its .ktx2 tiles
```

You can run the same command again later. It keeps valid files and rebuilds files whose source image or recipe changed.

### 8. Point the Scene at the generated files

Open the Scene JSON used by your module's compendium build. This is the `MAP_NAME.json` file from step 4.

For every entry in the Scene's `levels` list, replace only `background.src`. Use that Level's generated folder name:

```json
"background": {
  "src": "modules/MODULE_ID/assets/maps/MAP_NAME-pyramid/ground-floor/z0/0-0.ktx2"
}
```

At the top level of the Scene, set its thumbnail:

```json
"thumb": "modules/MODULE_ID/assets/maps/MAP_NAME-pyramid/thumb.webp"
```

Add `theiks-ktx2-renderer` inside the Scene's existing `flags` object. Keep any other flags already there:

```json
"flags": {
  "theiks-ktx2-renderer": {
    "mapPyramid": {
      "version": 1,
      "manifest": "modules/MODULE_ID/assets/maps/MAP_NAME-pyramid/manifest.json"
    }
  }
}
```

Rebuild your module's Scene compendium with the same pack-building command you normally use.

### 9. Verify and ship

Run:

```powershell
node tools/pyramid.mjs verify --config "../MODULE_FOLDER/tools/maps/MAP_NAME-pyramid.json" --masters "../MODULE_FOLDER/assets/masters" --output "../MODULE_FOLDER/assets/maps/MAP_NAME-pyramid" --module-id "MODULE_ID" --module-root "../MODULE_FOLDER"
```

Then test the packed Scene in Foundry:

1. Enable your map module and Theik's KTX2 Renderer.
2. Open the Scene.
3. Switch through every floor.
4. Zoom in and pan to each edge.

Commit `module.json`, the pyramid recipe, the edited Scene source, and the complete `assets/maps/MAP_NAME-pyramid/` folder. Keep `assets/masters/` out of the released module and your Git repository.

### Updating the map later

If only the artwork changed:

1. Replace the matching WebP in `assets/masters/`. Keep its filename and dimensions unchanged.
2. Run the `rebuild` command from step 7.
3. Run `verify` from step 9.
4. Commit the changed files in `assets/maps/MAP_NAME-pyramid/`.

If the Scene size, grid size, floor names, or floor list changed:

1. Export the Scene JSON again.
2. Replace the WebP masters.
3. Repeat steps 5 through 9.

Do not fix a failed build by guessing values in the recipe. Run the proposer again, then read the first error from `doctor`.

### Optional: ask a coding agent to create the recipe

The `.agents/skills/ktx2-pyramid-json` folder teaches a compatible coding agent how to perform steps 5 and 6. The agent must have both module folders in its workspace. Give it the three real paths:

```text
$ktx2-pyramid-json
Scene JSON: ../MODULE_FOLDER/packs-src/maps/MAP_NAME.json
Masters: ../MODULE_FOLDER/assets/masters
Write: ../MODULE_FOLDER/tools/maps/MAP_NAME-pyramid.json
Do not rebuild KTX2.
```

The agent creates the recipe and checks it. It does not start the long KTX2 build.

## Encoding rules

These are load-bearing. Wrong mip counts or unaligned sizes are what produce black tiles.

- KTX-Software CLI **exactly 4.4.2**. Foundry 14 transcodes UASTC to BC7 on common GPUs.
- Every tile is **UASTC + Zstd**, **one mip level** (`mipLevels: 1`). Never `--generate-mipmap`, never a mip chain.
- Every physical texture size must be **aligned to 4×4**. The tooling derives a gutter that aligns every configured tile in a tier and maps to whole master pixels.
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

# Patch notes

## 1.0.4

- Fixed incorrect release version metadata that prevented versions 1.0.2 and 1.0.3 from publishing.

## 1.0.3

- Map tiles now preload around the camera and appear one at a time. Foundry's performance mode sets the load limit to one, two, or four concurrent requests.
- The renderer replaces the old pan debounce with one demand update per animation frame. It cancels queued tiles that are no longer needed and keeps useful results from requests that already started.
- Higher-density tiles use cropped lower-density fragments until their own texture arrives. Each display slot swaps fallback and detail in one update, which prevents gaps and double-blended transparency.
- Every least-density tile for the visible floors loads with the Scene. Detail for the initial active viewport also loads before drawing finishes, but a detail failure cannot stop the Scene from opening.
- Failed detail tiles keep their fallback and retry after 5 seconds, 15 seconds, then every 60 seconds while still needed. The GM receives one warning per Scene, and the console identifies each failed path.
- The renderer keeps Foundry's native background until all visible areas have detail, fallback, or an intentional blank. Missing manifests and failed least-density tiles remain fatal and restore the native backgrounds.
- Pyramid recipes can contain any number of density tiers. Low selects the least-dense tier, Medium selects the tier nearest density 1, High selects the densest tier, and Auto uses density-based hysteresis. Existing three-tier schema-version-1 manifests still work.
- The proposer creates extra `z3` and higher tiers for large masters. Normal 2x masters still produce `z0`, `z1`, and `z2` at densities 0.5, 1, and 2.
- Fully transparent detail content becomes a sparse `blank: true` manifest entry with no KTX2 file. The alpha check ignores gutters, least-density fallback tiles always remain encoded, and verification rejects stray or malformed tile files.
- Master images are no longer limited to RGBA WebP. The tools now accept the single-image formats supported by Sharp, including WebP, PNG, JPEG, AVIF, TIFF, GIF, and SVG. They preserve source transparency and give formats without alpha an opaque channel.
- `getMapStreamingStats()` now reports queued, in-flight, failed, visible-slot, and prefetched tile counts while keeping its existing fields.

## 1.0.2

- New `pyramid.json` files no longer need a `gutter` value. The build tools calculate a compatible gutter for each tier. Existing configs with an explicit gutter still work.
- Reworked the README's map-module guide with step-by-step setup, first-build, update, Scene configuration, and verification instructions.

## 1.0.1

- KTX2 level backgrounds now follow Foundry's configured level visibility instead of rendering every lower floor.

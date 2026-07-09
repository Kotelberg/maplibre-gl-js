import {mat4, vec4} from 'gl-matrix';
import Point from '@mapbox/point-geometry';
import {mercatorZfromAltitude} from '../../geo/mercator_coordinate';
import {calculateTileMatrix} from '../../geo/projection/mercator_utils';

import type {PaddingOptions} from '../../geo/edge_insets';
import type {UnwrappedTileIDType} from '../../geo/transform_helper';

/**
 * The subset of the transform the shadow frustum fit reads. Satisfied by `IReadonlyTransform`
 * (`MercatorTransform`), and small enough to construct directly in a unit test. All world-space
 * quantities below are in **mercator world-pixels at the current scale** — the same space
 * `calculateTileMatrix(unwrappedTileID, worldSize)` maps a tile's EXTENT-local coordinates into
 * (`src/geo/projection/mercator_utils.ts:76`). That is the coordinate space Task 2's caster and
 * Task 3's receivers both build their per-tile light matrices in, so the fit MUST live here too.
 *
 * Native works in `TransformState::matrixFor()` units, documented as "mercator screen-pixels at the
 * current scale (1 world unit == 1 screen pixel at the map center)". gl-js's `worldSize` space
 * (`tileSize * scale`, tileSize 512) is exactly that, so the port is a 1:1 coordinate mapping.
 */
export interface ShadowTransformLike {
    readonly zoom: number;
    readonly bearingInRadians: number;
    readonly pitchInRadians: number;
    readonly worldSize: number;
    readonly width: number;
    readonly height: number;
    readonly center: {lat: number};
    readonly padding: PaddingOptions;
    /** Unproject a screen pixel to a normalized mercator coordinate (0..1) on the z=0 plane. */
    screenPointToMercatorCoordinate(p: Point): {x: number; y: number};
}

type Vec3 = [number, number, number];
type Aabb = {min: Vec3; max: Vec3};

function newMat4(): mat4 {
    return mat4.identity(new Float64Array(16) as unknown as mat4);
}

function normalize(v: Vec3): Vec3 {
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    const i = l > 0 ? 1 / l : 0;
    return [v[0] * i, v[1] * i, v[2] * i];
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * World-pixels-per-meter for the building HEIGHT axis. Direct port of native `pixelsPerMeter`
 * (`shadow_tweakers.cpp:73-78`): `worldSize / (cos(lat) * 2pi * EARTH_RADIUS_M)`. In gl-js this is
 * exactly `mercatorZfromAltitude(1, lat) * worldSize` because
 * `mercatorZfromAltitude(1, lat) = 1 / (earthCircumference * cos(lat)) = 1 / (2pi * R * cos(lat))`
 * (`src/geo/mercator_coordinate.ts:13,25`). Grows with zoom, so caster height tracks its footprint.
 */
export function shadowPixelsPerMeter(transform: ShadowTransformLike): number {
    return mercatorZfromAltitude(1, transform.center.lat) * transform.worldSize;
}

/**
 * Tile-local (EXTENT units, z in METERS) → mercator world-pixel matrix for the shadow caster and
 * receivers. Direct port of native `matrixForLightTileWorld` (`shadow_tweakers.cpp:82-93`).
 *
 * `calculateTileMatrix` maps x/y from EXTENT units into world-pixels (scaling with zoom via
 * `worldSize`) but leaves **z at unit scale** — yet the fill-extrusion height vertex fed to the
 * caster/receiver is in **METERS**. Scaling z by `shadowPixelsPerMeter` puts the building HEIGHT into
 * the same world-pixel space as its FOOTPRINT, so the cast-shadow length is world-fixed
 * (height·tan(sun) in world space, independent of camera zoom) instead of shrinking as you zoom in.
 * Both footprint (x/y) and height (z) then scale TOGETHER with zoom, and the sticky cache's uniform
 * `1/liveS` rescale (`shadow_cache.ts`) keeps them consistent on cache-hit frames.
 *
 * Evaluated at the LIVE zoom every frame (matching native's per-frame `pixelsPerMeter(state)`), the
 * `pixelsPerMeter` argument is constant across a frame's tiles, so callers compute it once via
 * {@link shadowPixelsPerMeter} and pass it in.
 */
export function lightTileWorldMatrix(
    unwrappedTileID: UnwrappedTileIDType,
    worldSize: number,
    pixelsPerMeter: number
): mat4 {
    const m = calculateTileMatrix(unwrappedTileID, worldSize);
    // matrixFor gives x/y in world-pixels (scale with zoom) but leaves z at unit scale; the FE height
    // vertex is in METERS, so scale z by world-pixels-per-meter to match the footprint (native #2).
    mat4.scale(m, m, [1, 1, pixelsPerMeter]);
    return m;
}

/**
 * Rotation-only light view matrix: camera at the sun direction, looking back toward the origin.
 * Verbatim port of native `ShadowFrustum::lightView` (`shadow_frustum.cpp:22-40`). Translation is
 * folded into the ortho fit ({@link fitLightClip}). Column-major mat4 index convention matches native
 * and gl-matrix identically.
 */
export function lightView(sunDir: Vec3): mat4 {
    const fwd = normalize([-sunDir[0], -sunDir[1], -sunDir[2]]);
    const worldUp: Vec3 = Math.abs(fwd[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const right = normalize(cross(worldUp, fwd));
    const up = cross(fwd, right);

    const m = newMat4();
    m[0] = right[0]; m[4] = right[1]; m[8] = right[2];
    m[1] = up[0]; m[5] = up[1]; m[9] = up[2];
    m[2] = fwd[0]; m[6] = fwd[1]; m[10] = fwd[2];
    return m;
}

function lightSpaceAabb(sunDir: Vec3, worldPoints: Vec3[]): Aabb {
    const view = lightView(sunDir);
    const box: Aabb = {min: [1e30, 1e30, 1e30], max: [-1e30, -1e30, -1e30]};
    const lp = vec4.create();
    for (const p of worldPoints) {
        vec4.transformMat4(lp, [p[0], p[1], p[2], 1.0] as vec4, view);
        for (let i = 0; i < 3; i++) {
            box.min[i] = Math.min(box.min[i], lp[i]);
            box.max[i] = Math.max(box.max[i], lp[i]);
        }
    }
    return box;
}

/**
 * Snap a value down to a world-grid multiple. Verbatim port of native `ShadowFrustum::texelSnap`
 * (`shadow_frustum.cpp:52-55`). Holding the box size constant (see {@link fitLightClip}) makes the
 * world-to-texel scale frame-invariant, so this snap keeps the sampling grid stable (no crawl).
 */
export function texelSnap(value: number, texelWorldSize: number): number {
    if (texelWorldSize <= 0) return value;
    return Math.floor(value / texelWorldSize) * texelWorldSize;
}

/** Verbatim port of native `ShadowFrustum::heightExpand` (`shadow_frustum.cpp:57-66`). */
export function heightExpand(groundPoints: Vec3[], maxHeight: number): Vec3[] {
    const out: Vec3[] = [];
    for (const p of groundPoints) {
        out.push([p[0], p[1], 0.0]);
        out.push([p[0], p[1], maxHeight]);
    }
    return out;
}

/**
 * Fit a world-to-light-clip matrix around `worldPoints`. Verbatim port of native
 * `ShadowFrustum::fit` (`shadow_frustum.cpp:68-130`).
 *
 * **Z convention (the firm contract with Tasks 2 and 3).** The ortho maps light-space z from
 * `[box.min.z, box.max.z]` into **`[0, 1]`** (`ortho[10] = invZ`, `ortho[14] = -box.min.z * invZ`),
 * the Metal/Vulkan/D3D depth convention — NOT the GL `[-1,1]` convention. This is deliberate and
 * shared: Task 2's caster packs `v_depth01 = clip.z / clip.w` (already in `[0,1]`) and remaps ONLY
 * `gl_Position.z` (`clip.z = 2*clip.z - clip.w`) for its own hardware depth buffer; Task 3's
 * receivers compare `ndc.z = sp.z / sp.w` against the `[0,1]` unpacked depth with NO remap. All
 * three agree because THIS matrix already emits `clip.z/clip.w` in `[0,1]`. x/y map to `[-1,1]`.
 */
export function fitLightClip(
    sunDir: Vec3,
    worldPoints: Vec3[],
    mapSize: number,
    texelSnapEnabled: boolean
): mat4 {
    const view = lightView(sunDir);
    const box = lightSpaceAabb(sunDir, worldPoints);

    if (texelSnapEnabled && mapSize > 0) {
        // Hold the box SIZE constant (fixed-radius footprint under a world-fixed sun) and snap only
        // the origin to the texel grid, so the world-to-texel scale is identical frame-to-frame and
        // the snapped grid is truly stable. (native shadow_frustum.cpp:76-90)
        const sizeX = box.max[0] - box.min[0];
        const sizeY = box.max[1] - box.min[1];
        const texelX = sizeX / mapSize;
        const texelY = sizeY / mapSize;
        box.min[0] = texelSnap(box.min[0], texelX);
        box.min[1] = texelSnap(box.min[1], texelY);
        box.max[0] = box.min[0] + sizeX;
        box.max[1] = box.min[1] + sizeY;
    }

    // Guard against a degenerate (zero-extent) range producing a singular projection.
    for (let i = 0; i < 3; i++) {
        if (box.max[i] - box.min[i] < 1e-6) {
            box.max[i] = box.min[i] + 1.0;
        }
    }

    // Small depth margin (zPad) so casters exactly on the near/far plane aren't clipped. This is
    // what guarantees no real occluder ever encodes packed depth near 0, so the section 3.3.1
    // unwritten-texel guard is provably safe. (native shadow_frustum.cpp:98-102)
    {
        const zPad = (box.max[2] - box.min[2]) * 0.02 + 1.0;
        box.min[2] -= zPad;
        box.max[2] += zPad;
    }

    const invX = 1.0 / (box.max[0] - box.min[0]);
    const invY = 1.0 / (box.max[1] - box.min[1]);
    const invZ = 1.0 / (box.max[2] - box.min[2]);

    const ortho = newMat4();
    ortho[0] = 2.0 * invX;
    ortho[5] = 2.0 * invY;
    ortho[10] = invZ;
    ortho[12] = -(box.max[0] + box.min[0]) * invX;
    ortho[13] = -(box.max[1] + box.min[1]) * invY;
    ortho[14] = -box.min[2] * invZ;

    const out = newMat4();
    mat4.multiply(out, ortho, view);
    return out;
}

/** Padded look-at offset from the geometric screen center (native `paddedCenterOffset`). */
function paddedCenterOffset(transform: ShadowTransformLike): {x: number; y: number} {
    const ins = transform.padding;
    const left = ins.left ?? 0;
    const right = ins.right ?? 0;
    const top = ins.top ?? 0;
    const bottom = ins.bottom ?? 0;
    return {x: 0.5 * (left - right), y: 0.5 * (top - bottom)};
}

/**
 * Screen pixel to world-pixel point on the ground (z=0). gl-js collapses native's focal-zoom tile
 * round-trip into a single normalized unproject scaled by worldSize (both yield the same world-px
 * point at the current scale).
 */
function screenPixelToWorld(transform: ShadowTransformLike, px: number, py: number): Vec3 {
    const merc = transform.screenPointToMercatorCoordinate(new Point(px, py));
    return [merc.x * transform.worldSize, merc.y * transform.worldSize, 0.0];
}

function centerPixelToWorld(transform: ShadowTransformLike): Vec3 {
    const off = paddedCenterOffset(transform);
    return screenPixelToWorld(transform, 0.5 * transform.width + off.x, 0.5 * transform.height + off.y);
}

/**
 * The view's required shadow footprint: focal (look-at) center in world-px plus the bearing-invariant
 * scalar far radius covering the visible ground. Verbatim port of native `shadowViewFootprint`
 * (`shadow_tweakers.cpp:140-168`). Pulled out so the sticky cache reuses the EXACT same math for its
 * containment test — one definition of "what must be covered this frame".
 */
export function shadowViewFootprint(transform: ShadowTransformLike): {center: Vec3; farRadius: number} {
    const center = centerPixelToWorld(transform);

    const w = transform.width;
    const h = transform.height;
    const screenExtent = 0.5 * Math.hypot(w, h);
    const minRadius = 1.8 * screenExtent; // floor: keep ~screen coverage at flat pitch
    const maxDist = 4000.0; // world-px ceiling on coverage
    const cornerFactor = 1.3; // top corners reach farther than top-center

    // Bearing-invariant coverage radius = farthest the visible ground reaches FORWARD from the
    // look-at, sampled down the screen's center column (peaks just below the horizon). A scalar (max
    // distance), hence invariant to compass bearing, so the symmetric frustum stays put under rotation.
    let reach = 0.0;
    const colX = 0.5 * w + paddedCenterOffset(transform).x;
    const fy = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5];
    for (const f of fy) {
        const wpt = screenPixelToWorld(transform, colX, f * h);
        const d = Math.hypot(wpt[0] - center[0], wpt[1] - center[1]);
        if (Number.isFinite(d)) {
            reach = Math.max(reach, Math.min(d, maxDist));
        }
    }
    const farRadius = Math.min(Math.max(minRadius, reach * cornerFactor), maxDist);
    return {center, farRadius};
}

/**
 * Default assumed max building height (meters) for the light frustum's z-range. Native hardcodes
 * `200.0` (`shadow_tweakers.cpp` computeWorldToLightClipCascades). Passing the real measured max
 * caster height instead keeps `cascadeCount === 1` fit-shaped like native while tightening depth
 * precision; the default reproduces native exactly.
 */
export const SHADOW_ASSUMED_MAX_HEIGHT_M = 200.0;

/**
 * Concentric cascaded world-to-light-clip matrices. Verbatim port of native
 * `computeWorldToLightClipCascades` (`shadow_tweakers.cpp:205-334`). All cascades share ONE focal
 * center and ONE pair of sun-ground axes, differing ONLY in a scalar radius, so every cascade is
 * bearing-invariant (the shadows stay put under rotation). `cascadeCount === 1` reproduces the legacy
 * single-map fit.
 *
 * `overrideCenter`/`overrideFarRadius` (used by the sticky cache) pin the frustum around a fixed
 * world center with an oversized radius so it survives panning; omit them for the live per-frame fit.
 */
export function computeWorldToLightClipCascades(
    transform: ShadowTransformLike,
    sunDir: Vec3,
    mapSize: number,
    cascadeCount: number,
    split: number,
    maxHeightMeters: number = SHADOW_ASSUMED_MAX_HEIGHT_M,
    overrideCenter?: Vec3,
    overrideFarRadius: number = 0.0
): mat4[] {
    // Z-range in WORLD-PIXELS: the assumed max height is in METERS, converted with the same per-zoom
    // pixelsPerMeter the caster height uses, so a tall building's scaled caster roof doesn't punch
    // out of a fixed-world-px frustum top at high zoom (which would Z-clip to a short/missing shadow).
    const maxHeightWorld = maxHeightMeters * shadowPixelsPerMeter(transform);

    const view = shadowViewFootprint(transform);
    const focalCenter: Vec3 = overrideCenter ?? view.center;
    const farRadius = overrideCenter ? overrideFarRadius : view.farRadius;

    // Footprint aligned to the SUN's GROUND axes so that in light space it is an axis-aligned square
    // that FILLS the whole shadow map (a world-axis square becomes a 45deg diamond in light space,
    // wasting ~half the map, so "shadows only in part of the screen"). rightG is perpendicular to the
    // sun ground dir, sunG is the sun ground dir. A square of half-side `radius` along these axes
    // still contains the full visible disk of radius `radius`. Shared by every cascade — only the
    // radius shrinks per cascade.
    const fwdHyp = Math.hypot(sunDir[0], sunDir[1]);
    let rgx = 1.0, rgy = 0.0, sgx = 0.0, sgy = 1.0; // overhead-sun fallback: world axes
    if (fwdHyp > 1e-4) {
        rgx = sunDir[1] / fwdHyp;
        rgy = -sunDir[0] / fwdHyp;
        sgx = -sunDir[0] / fwdHyp;
        sgy = -sunDir[1] / fwdHyp;
    }

    const fitForRadius = (radius: number): mat4 => {
        const footprint: Vec3[] = [
            [focalCenter[0] - radius * rgx - radius * sgx, focalCenter[1] - radius * rgy - radius * sgy, 0.0],
            [focalCenter[0] + radius * rgx - radius * sgx, focalCenter[1] + radius * rgy - radius * sgy, 0.0],
            [focalCenter[0] - radius * rgx + radius * sgx, focalCenter[1] - radius * rgy + radius * sgy, 0.0],
            [focalCenter[0] + radius * rgx + radius * sgx, focalCenter[1] + radius * rgy + radius * sgy, 0.0]
        ];
        const pts = heightExpand(footprint, maxHeightWorld);
        return fitLightClip(sunDir, pts, mapSize, /* texelSnapEnabled */ true);
    };

    const count = cascadeCount < 1 ? 1 : cascadeCount;
    const cascades: mat4[] = [];
    for (let c = 0; c < count; c++) {
        // Concentric radii: last cascade (c === count-1) is the full far radius; each nearer cascade
        // is `split` times the next (geometric). count===1 gives a single radius === farRadius.
        let radius = farRadius;
        if (count > 1) {
            const factor = Math.pow(split, count - 1 - c);
            radius = farRadius * factor;
        }
        cascades.push(fitForRadius(radius));
    }
    return cascades;
}

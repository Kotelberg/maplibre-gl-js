import {mat4} from 'gl-matrix';
import {
    computeWorldToLightClipCascades,
    shadowViewFootprint,
    SHADOW_ASSUMED_MAX_HEIGHT_M,
    type ShadowTransformLike
} from './shadow_frustum';
import {shadowSunDirection, type CartesianLightPosition} from './shadow_sun';
import {SHADOW_MAP_DEFAULT_SIZE} from './shadow_map';

export {SHADOW_MAP_DEFAULT_SIZE} from './shadow_map';

type Vec3 = [number, number, number];

// Refit-policy + cascade constants, verbatim from the native shadow pass/tweakers (657952f4).
/** Cached far radius = view radius x this, giving ~0.5*radius of pan headroom (`shadow_tweakers.cpp:347`). */
export const SHADOW_OVERSIZE = 1.5;
/** Refit for sharpness once live world-scale exceeds this x cached (~0.58 zoom in) (`shadow_tweakers.cpp:348`). */
export const SHADOW_ZOOM_IN_REFIT = 1.5;
/** Cascade split fraction default (`shadow_pass.cpp:91-99`). */
export const SHADOW_CASCADE_SPLIT_DEFAULT = 0.4;
/** Default allocated cascade count — gl-js follows the GL/Vulkan backend (`shadow_pass.cpp:28-53`, §3.9). */
export const SHADOW_CASCADE_COUNT_DEFAULT = 1;
/** Near-cascade pitch gate threshold in degrees (`shadow_pass.cpp`, `activeShadowCascadeCount`). */
export const SHADOW_PITCH_GATE_DEG = 20;

/**
 * Pitch-gated active cascade count. Verbatim port of native `activeShadowCascadeCount`
 * (`shadow_pass.cpp:47-71`): a near-top-down view (pitch under the threshold) drops to the single
 * full-density cascade; a pitched view engages the near cascade. Moot at the 1-cascade default.
 */
export function activeShadowCascadeCount(
    allocatedCount: number,
    pitchRadians: number,
    thresholdDeg: number = SHADOW_PITCH_GATE_DEG
): number {
    if (allocatedCount <= 1) return allocatedCount;
    const thresholdRad = thresholdDeg * (Math.PI / 180);
    return pitchRadians >= thresholdRad ? allocatedCount : 1;
}

/**
 * Per-frame rescale factor `liveS`, guarding the invalid sentinel. Verbatim port of the native guard
 * (`shadow_tweakers.cpp:400`): `(fs.valid && fs.cachedZoom >= 0.0) ? exp2(zoom - cachedZoom) : 1.0`.
 *
 * Extracted as a pure function so the sentinel guard is directly unit-testable: an un-fitted cache
 * (`cachedZoom === -1`) must yield exactly `1.0` — never `exp2(zoom + 1)`, a ~5-orders-of-magnitude
 * scale that collapses the light matrices into a degenerate projection (the D3 grey-wash bug).
 */
export function liveRescaleFactor(valid: boolean, cachedZoom: number, zoom: number): number {
    return valid && cachedZoom >= 0.0 ? Math.pow(2, zoom - cachedZoom) : 1.0;
}

/**
 * Sticky shadow-map cache state. Direct port of native `ShadowFrustumState`
 * (`include/mbgl/renderer/shadows/shadow_tweakers.hpp`). Held per-map by the painter (Task 5) and
 * threaded through {@link refreshShadowFrustum} / {@link updateShadowFrame} each frame.
 */
export type ShadowFrustumState = {
    valid: boolean;
    mapSize: number;
    cascadeCount: number;
    /** Base cascades, fitted + texel-snapped at `cachedZoom` — what the caster renders the depth map with. */
    cascades: mat4[];
    /** `cascades` rescaled to the live zoom each frame (x 1/2^(zoom-cachedZoom)). Tweakers sample THIS. */
    liveCascades: mat4[];
    cachedCenter: Vec3; // world-px center the cached frustum is fitted around
    cachedFarRadius: number; // OVERSIZED far radius (pan headroom beyond the live view)
    cachedZoom: number; // zoom the cache was fitted at; sentinel -1 = never fitted
    castersDirty: boolean; // a fill-extrusion layer changed its caster set, forcing a refit
    /**
     * Latch: has a caster pass actually rendered one or more casters into the shadow map? Set by the
     * caster orchestration (Task 5), never reset by the cache. Receivers gate shadows on this and stay
     * lit while false, so they never sample an un-rendered map (the D3 grey-wash guard, §3.3.3).
     * refreshShadowFrustum MUST NOT flip this — the receiver runs before the caster on the GPU.
     */
    shadowMapUsable: boolean;
};

/** Fresh state carrying the sentinel `cachedZoom = -1` and `valid = false`. */
export function createShadowFrustumState(): ShadowFrustumState {
    return {
        valid: false,
        mapSize: 0,
        cascadeCount: 0,
        cascades: [],
        liveCascades: [],
        cachedCenter: [0, 0, 0],
        cachedFarRadius: 0,
        cachedZoom: -1.0,
        castersDirty: false,
        shadowMapUsable: false
    };
}

/**
 * Sticky-cache entry point. Verbatim port of native `refreshShadowFrustum`
 * (`shadow_tweakers.cpp:336-406`). Re-fits (and returns `true`) ONLY when the cache can't serve this
 * frame; otherwise reuses the base cascades. Either way it refreshes `fs.liveCascades` (base cascades
 * rescaled to the live zoom). Returns whether a refit happened (the caller must re-render the caster
 * pass on a refit).
 */
export function refreshShadowFrustum(
    fs: ShadowFrustumState,
    transform: ShadowTransformLike,
    sunDir: Vec3,
    mapSize: number,
    activeCascades: number,
    split: number,
    maxHeightMeters: number = SHADOW_ASSUMED_MAX_HEIGHT_M
): boolean {
    const {center: viewCenter, farRadius: viewFarRadius} = shadowViewFootprint(transform);
    const zoom = transform.zoom;

    let refit =
        !fs.valid || fs.castersDirty || fs.mapSize !== mapSize || fs.cascadeCount !== activeCascades;
    if (!refit) {
        // World coords scale with zoom; S = live/cached world-scale ratio. Rescale the SAMPLING
        // matrices by 1/S rather than re-rendering. Refit only when zooming IN past the cached map's
        // resolution, or when pan/zoom-out pushes the live view disk outside the cached oversized
        // coverage (compared in LIVE world-px: cached center/radius x S).
        const S = Math.pow(2, zoom - fs.cachedZoom);
        if (S > SHADOW_ZOOM_IN_REFIT) {
            refit = true;
        } else {
            const dist = Math.hypot(
                viewCenter[0] - fs.cachedCenter[0] * S,
                viewCenter[1] - fs.cachedCenter[1] * S
            );
            refit = dist + viewFarRadius > fs.cachedFarRadius * S;
        }
    }

    if (refit) {
        fs.cachedCenter = viewCenter;
        fs.cachedFarRadius = viewFarRadius * SHADOW_OVERSIZE;
        fs.cachedZoom = zoom;
        fs.cascades = computeWorldToLightClipCascades(
            transform,
            sunDir,
            mapSize,
            activeCascades,
            split,
            maxHeightMeters,
            fs.cachedCenter,
            fs.cachedFarRadius
        );
        fs.cascadeCount = activeCascades;
        fs.mapSize = mapSize;
        fs.castersDirty = false;
        fs.valid = true;
    }

    // Per-frame: rescale the BASE cascades to the live zoom. On a refit frame cachedZoom === zoom,
    // so liveS === 1.0 exactly (IEEE-754 exp2(0)) and liveCascades === cascades bit-for-bit (the
    // §3.10 zoom-stable identity). The sentinel guard (liveRescaleFactor) treats an un-fitted cache
    // as 1.0.
    const liveS = liveRescaleFactor(fs.valid, fs.cachedZoom, zoom);
    const inv = 1.0 / liveS;
    fs.liveCascades.length = fs.cascades.length;
    for (let c = 0; c < fs.cascades.length; c++) {
        const out = fs.liveCascades[c] ?? (new Float64Array(16) as unknown as mat4);
        mat4.scale(out, fs.cascades[c], [inv, inv, inv]);
        fs.liveCascades[c] = out;
    }
    return refit;
}

/**
 * The evaluated `light` inputs the shadow frame reads. Task 5 supplies these from the per-frame
 * `Light` evaluation (`light.properties.get(...)`).
 */
export type ShadowLightInput = {
    position: CartesianLightPosition;
    anchor: 'map' | 'viewport';
    castShadows: boolean;
    shadowIntensity: number;
};

export type ShadowFrameOptions = {
    /** Per-cascade map size (default {@link SHADOW_MAP_DEFAULT_SIZE}). */
    mapSize?: number;
    /** Allocated cascade count before pitch gating (default {@link SHADOW_CASCADE_COUNT_DEFAULT}). */
    allocatedCascadeCount?: number;
    /** Cascade split fraction (default {@link SHADOW_CASCADE_SPLIT_DEFAULT}). */
    split?: number;
    /** Measured max caster height in meters (default {@link SHADOW_ASSUMED_MAX_HEIGHT_M}, native 200). */
    casterMaxHeightMeters?: number;
    /** Mark casters changed (new tiles streamed in), forcing a refit this frame. */
    castersDirty?: boolean;
};

/**
 * Per-frame orchestration contract consumed by the painter (Task 5). Given the frame's transform plus
 * evaluated light, it drives {@link refreshShadowFrustum} and returns everything Tasks 2/3 need:
 *
 * - `cascades` — the per-cascade `liveCascades` (world-px to light-clip, `[0,1]` z), the ONE
 *   `worldToLightClip` per cascade shared by the caster ({@link drawShadowCasters}) and both
 *   receivers. Task 5 composes each per-tile matrix as `cascades[c] * calculateTileMatrix(coord)`.
 * - `baseCascades` — the depth-map render matrices (fitted at `cachedZoom`); equal `cascades` on a
 *   refit frame.
 * - `refitThisFrame` — the caster pass must re-render the depth maps when true.
 * - `usable` — the receiver shadow-intensity gate (`shadowMapUsable`); stays false until Task 5
 *   latches it via {@link markShadowMapUsable} after a successful caster pass.
 *
 * The `fs` state is owned and persisted by the caller across frames (do NOT recreate it per frame).
 */
export function updateShadowFrame(
    fs: ShadowFrustumState,
    transform: ShadowTransformLike,
    light: ShadowLightInput,
    options: ShadowFrameOptions = {}
): {
    cascades: mat4[];
    baseCascades: mat4[];
    cascadeCount: number;
    mapSize: number;
    texelSize: number;
    sunDirection: Vec3;
    refitThisFrame: boolean;
    usable: boolean;
} {
    const mapSize = options.mapSize ?? SHADOW_MAP_DEFAULT_SIZE;
    const allocated = options.allocatedCascadeCount ?? SHADOW_CASCADE_COUNT_DEFAULT;
    const split = options.split ?? SHADOW_CASCADE_SPLIT_DEFAULT;
    const maxHeight = options.casterMaxHeightMeters ?? SHADOW_ASSUMED_MAX_HEIGHT_M;

    if (options.castersDirty) {
        fs.castersDirty = true;
    }

    const sunDir = shadowSunDirection(light.position, light.anchor, transform.bearingInRadians);
    const activeCascades = activeShadowCascadeCount(allocated, transform.pitchInRadians);
    const refit = refreshShadowFrustum(fs, transform, sunDir, mapSize, activeCascades, split, maxHeight);

    return {
        cascades: fs.liveCascades,
        baseCascades: fs.cascades,
        cascadeCount: fs.cascadeCount,
        mapSize,
        texelSize: 1 / mapSize,
        sunDirection: sunDir,
        refitThisFrame: refit,
        usable: fs.shadowMapUsable
    };
}

/**
 * Latch `shadowMapUsable` true after the caster pass has rendered one or more casters into the shadow
 * map. Called by Task 5's orchestration once the caster pass produced a non-empty map; never reset by
 * the cache (native `ShadowFrustumState::shadowMapUsable` latch semantics).
 */
export function markShadowMapUsable(fs: ShadowFrustumState): void {
    fs.shadowMapUsable = true;
}

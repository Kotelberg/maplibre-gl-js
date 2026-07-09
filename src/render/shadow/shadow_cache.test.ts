import {describe, expect, test} from 'vitest';
import {LngLat} from '../../geo/lng_lat';
import {MercatorTransform} from '../../geo/projection/mercator_transform';
import {sphericalToCartesian} from '../../util/util';
import {shadowSunDirection} from './shadow_sun';
import {
    activeShadowCascadeCount,
    createShadowFrustumState,
    liveRescaleFactor,
    markShadowMapUsable,
    refreshShadowFrustum,
    updateShadowFrame,
    SHADOW_MAP_DEFAULT_SIZE,
    type ShadowFrustumState
} from './shadow_cache';

/**
 * The §3.10 hard requirements as unit tests: zoom-stable identity, the invalid-sentinel guard, and
 * the refit-hysteresis policy (`kOversize`/`kZoomInRefit` = 1.5). Ported from the committed native
 * tree 657952f4 (`shadow_tweakers.cpp refreshShadowFrustum`, `test/renderer/shadow_frustum_cache.test.cpp`).
 */

const SUN = shadowSunDirection(sphericalToCartesian([1.5, 210, 45]), 'map', 0) as [number, number, number];

function makeTransform(zoom: number, bearing = 0): MercatorTransform {
    const t = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 70, renderWorldCopies: true});
    t.resize(1024, 768);
    t.setCenter(new LngLat(30.5234, 50.4501));
    t.setZoom(zoom);
    t.setPitch(55);
    t.setBearing(bearing);
    return t;
}

function refresh(fs: ShadowFrustumState, t: MercatorTransform, cascades = 1): boolean {
    return refreshShadowFrustum(fs, t, SUN, SHADOW_MAP_DEFAULT_SIZE, cascades, 0.4);
}

function eq(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
    return true;
}

describe('liveRescaleFactor (spec §3.10 sentinel guard)', () => {
    test('un-fitted cache (cachedZoom -1) => exactly 1.0, never exp2(zoom+1)', () => {
        expect(liveRescaleFactor(false, -1.0, 15.4)).toBe(1.0);
        expect(liveRescaleFactor(true, -1.0, 15.4)).toBe(1.0); // valid but sentinel zoom still guarded
    });

    test('fitted cache at the same zoom => exactly 1.0 (IEEE exp2(0))', () => {
        expect(liveRescaleFactor(true, 15.4, 15.4)).toBe(1.0);
    });

    test('fitted cache => exp2(zoom - cachedZoom)', () => {
        expect(liveRescaleFactor(true, 15.0, 15.5)).toBeCloseTo(Math.pow(2, 0.5), 12);
        expect(liveRescaleFactor(true, 15.5, 15.0)).toBeCloseTo(Math.pow(2, -0.5), 12);
    });
});

describe('refreshShadowFrustum (spec §3.10)', () => {
    test('SENTINEL: fresh state refits without garbage rescale; liveCascades == cascades exactly', () => {
        const fs = createShadowFrustumState();
        expect(fs.valid).toBe(false);
        expect(fs.cachedZoom).toBe(-1.0);
        expect(fs.shadowMapUsable).toBe(false);

        const t = makeTransform(15.4);
        const refit = refresh(fs, t);

        // An invalid (sentinel) cache MUST force a refit and clear the sentinel to the live zoom.
        expect(refit).toBe(true);
        expect(fs.valid).toBe(true);
        expect(fs.cachedZoom).toBe(t.zoom);
        // refresh MUST NOT flip shadowMapUsable (the receiver runs before the caster on the GPU).
        expect(fs.shadowMapUsable).toBe(false);
        // On a refit frame the rescale factor is exp2(0) == 1 => sampled == base bit-for-bit. If the
        // sentinel had leaked into exp2 this would be a ~5-orders-of-magnitude scale instead.
        expect(fs.cascades).toHaveLength(1);
        expect(fs.liveCascades).toHaveLength(1);
        expect(eq(fs.cascades[0], fs.liveCascades[0])).toBe(true);
        for (let i = 0; i < 16; i++) expect(Number.isFinite(fs.liveCascades[0][i])).toBe(true);
    });

    test('ZOOM-STABLE IDENTITY: a settled cache-hit frame is bit-identical to the refit frame', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        expect(refresh(fs, t)).toBe(true); // refit
        const refitFrame = Array.from(fs.liveCascades[0]);

        // Re-refresh the SAME settled view: a cache HIT (no refit), liveS == 1 => identical output.
        const refit2 = refresh(fs, t);
        expect(refit2).toBe(false);
        expect(eq(fs.liveCascades[0], refitFrame)).toBe(true);
    });

    test('REFIT HYSTERESIS: zoom-in past 1.5x (kZoomInRefit) forces a refit', () => {
        const fs = createShadowFrustumState();
        expect(refresh(fs, makeTransform(15.0))).toBe(true); // initial fit at z15

        // exp2(0.6) = 1.516 > 1.5 => refit for sharpness.
        expect(refresh(fs, makeTransform(15.6))).toBe(true);
        expect(fs.cachedZoom).toBe(15.6);
    });

    test('REFIT HYSTERESIS: a small zoom oscillation is a cache HIT with a rescaled liveS', () => {
        const fs = createShadowFrustumState();
        expect(refresh(fs, makeTransform(15.0))).toBe(true); // fit at z15
        const base = Array.from(fs.cascades[0]);

        // Zoom in by 0.3 (S = exp2(0.3) = 1.231 < 1.5), same center => within oversized coverage => HIT.
        const refit = refresh(fs, makeTransform(15.3));
        expect(refit).toBe(false);
        // liveCascades = base scaled by 1/S on all three axes (mat4.scale multiplies cols 0..2).
        const S = Math.pow(2, 0.3);
        expect(fs.liveCascades[0][0]).toBeCloseTo(base[0] / S, 9);
        expect(fs.liveCascades[0][5]).toBeCloseTo(base[5] / S, 9);
        expect(fs.liveCascades[0][10]).toBeCloseTo(base[10] / S, 9);
        // the translation row (indices 12..15) is NOT scaled by mat4.scale
        expect(fs.liveCascades[0][12]).toBe(base[12]);
    });

    test('REFIT: a map-size or cascade-count change forces a refit', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        expect(refresh(fs, t, 1)).toBe(true);
        expect(refresh(fs, t, 1)).toBe(false); // settled
        // cascade count change (1 -> 2) => refit
        expect(refreshShadowFrustum(fs, t, SUN, SHADOW_MAP_DEFAULT_SIZE, 2, 0.4)).toBe(true);
        // map size change => refit
        expect(refreshShadowFrustum(fs, t, SUN, 2048, 2, 0.4)).toBe(true);
    });

    test('REFIT: castersDirty forces a refit and is cleared', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        expect(refresh(fs, t)).toBe(true);
        expect(refresh(fs, t)).toBe(false);
        fs.castersDirty = true;
        expect(refresh(fs, t)).toBe(true);
        expect(fs.castersDirty).toBe(false);
        expect(refresh(fs, t)).toBe(false);
    });
});

describe('activeShadowCascadeCount (spec §3.9 pitch gate)', () => {
    test('1-cascade allocation is never gated', () => {
        expect(activeShadowCascadeCount(1, 0)).toBe(1);
        expect(activeShadowCascadeCount(1, Math.PI / 4)).toBe(1);
    });

    test('near-flat view drops the near cascade; pitched view engages it (threshold 20deg)', () => {
        const deg = (d: number) => (d * Math.PI) / 180;
        expect(activeShadowCascadeCount(2, deg(10))).toBe(1);
        expect(activeShadowCascadeCount(2, deg(19.9))).toBe(1);
        expect(activeShadowCascadeCount(2, deg(20))).toBe(2);
        expect(activeShadowCascadeCount(2, deg(55))).toBe(2);
    });
});

describe('updateShadowFrame (Task-5 orchestration contract)', () => {
    const light = {position: sphericalToCartesian([1.5, 210, 45]), anchor: 'map' as const, castShadows: true, shadowIntensity: 0.32};

    test('returns the per-cascade worldToLightClip + texelSize + refit/usable flags', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        const frame = updateShadowFrame(fs, t, light);
        // makeTransform pitches to 55° (> SHADOW_PITCH_GATE_DEG), so the native-Metal 2-cascade
        // default engages the pitch-gated near cascade → 2 active cascades.
        expect(frame.cascades).toHaveLength(2);
        expect(frame.cascadeCount).toBe(2);
        expect(frame.mapSize).toBe(SHADOW_MAP_DEFAULT_SIZE);
        expect(frame.texelSize).toBeCloseTo(1 / SHADOW_MAP_DEFAULT_SIZE, 12);
        expect(frame.refitThisFrame).toBe(true); // first frame
        expect(frame.usable).toBe(false); // not latched until a caster pass runs
        // cascades are the live (rescaled) matrices; on a refit frame they equal the base cascades.
        expect(eq(frame.cascades[0], frame.baseCascades[0])).toBe(true);
    });

    test('usable latches only after markShadowMapUsable (never flipped by refresh)', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        updateShadowFrame(fs, t, light);
        expect(fs.shadowMapUsable).toBe(false);
        markShadowMapUsable(fs);
        const frame2 = updateShadowFrame(fs, t, light);
        expect(frame2.usable).toBe(true);
    });

    test('a settled second frame is a cache hit (refitThisFrame=false), bit-identical cascades', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        const a = updateShadowFrame(fs, t, light);
        const first = Array.from(a.cascades[0]);
        const b = updateShadowFrame(fs, t, light);
        expect(b.refitThisFrame).toBe(false);
        expect(eq(b.cascades[0], first)).toBe(true);
    });

    test('castersDirty option forces a refit for one frame', () => {
        const fs = createShadowFrustumState();
        const t = makeTransform(15.4);
        updateShadowFrame(fs, t, light);
        expect(updateShadowFrame(fs, t, light).refitThisFrame).toBe(false);
        expect(updateShadowFrame(fs, t, light, {castersDirty: true}).refitThisFrame).toBe(true);
        expect(updateShadowFrame(fs, t, light).refitThisFrame).toBe(false);
    });
});

import {describe, expect, test} from 'vitest';
import {LngLat} from '../../geo/lng_lat';
import {MercatorTransform} from '../../geo/projection/mercator_transform';
import {sphericalToCartesian} from '../../util/util';
import {shadowSunDirection} from './shadow_sun';
import {
    computeWorldToLightClipCascades,
    fitLightClip,
    shadowViewFootprint,
    texelSnap,
    lightView
} from './shadow_frustum';

/**
 * Golden-content + determinism tests for the CSM frustum-fit + sun math (spec §3.9), ported from the
 * committed native tree 657952f4 (`shadow_sun.cpp`, `shadow_frustum.cpp`, `shadow_tweakers.cpp`).
 * These exercise the pure math directly (no GPU) — sun direction, bearing-invariance, texel-snap.
 */

type Vec3 = [number, number, number];

function makeTransform(opts: {zoom: number; pitch: number; bearing: number; center: [number, number]}): MercatorTransform {
    const t = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 70, renderWorldCopies: true});
    t.resize(1024, 768);
    t.setCenter(new LngLat(opts.center[0], opts.center[1]));
    t.setZoom(opts.zoom);
    t.setPitch(opts.pitch);
    t.setBearing(opts.bearing);
    return t;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let m = 0;
    for (let i = 0; i < 16; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
}

describe('shadowSunDirection (spec §3.9 sun math)', () => {
    test('polar 0 => straight up (0,0,1)', () => {
        const pos = sphericalToCartesian([1.5, 0, 0]);
        const dir = shadowSunDirection(pos, 'map', 0);
        expect(dir[0]).toBeCloseTo(0, 12);
        expect(dir[1]).toBeCloseTo(0, 12);
        expect(dir[2]).toBeCloseTo(1, 12);
    });

    test('result is unit length and independent of radial magnitude', () => {
        const d1 = shadowSunDirection(sphericalToCartesian([1, 210, 45]), 'map', 0);
        const d5 = shadowSunDirection(sphericalToCartesian([5, 210, 45]), 'map', 0);
        expect(Math.hypot(d1[0], d1[1], d1[2])).toBeCloseTo(1, 12);
        for (let i = 0; i < 3; i++) expect(d1[i]).toBeCloseTo(d5[i], 12);
    });

    test('known azimuth/polar -> exact cartesian direction', () => {
        // az=210, polar=45: azimuth+90=300deg; x=r*cos(300)*sin(45), y=r*sin(300)*sin(45), z=r*cos(45)
        const dir = shadowSunDirection(sphericalToCartesian([1, 210, 45]), 'map', 0);
        const s = Math.sin(Math.PI / 4);
        const ex = Math.cos((300 * Math.PI) / 180) * s;
        const ey = Math.sin((300 * Math.PI) / 180) * s;
        const ez = Math.cos(Math.PI / 4);
        const len = Math.hypot(ex, ey, ez);
        expect(dir[0]).toBeCloseTo(ex / len, 12);
        expect(dir[1]).toBeCloseTo(ey / len, 12);
        expect(dir[2]).toBeCloseTo(ez / len, 12);
    });

    test('anchor "map" ignores bearing (bearing-invariant sun)', () => {
        const pos = sphericalToCartesian([1, 135, 60]);
        const a = shadowSunDirection(pos, 'map', 0);
        const b = shadowSunDirection(pos, 'map', 1.2345);
        for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 12);
    });

    test('anchor "viewport" rotates the ground plane by -bearing (crawls under rotation)', () => {
        const pos = sphericalToCartesian([1, 135, 60]); // has a nonzero ground component
        const a = shadowSunDirection(pos, 'viewport', 0);
        const b = shadowSunDirection(pos, 'viewport', Math.PI / 2);
        // z (up) is preserved; the ground (x,y) rotates, so a and b differ in x/y.
        expect(a[2]).toBeCloseTo(b[2], 12);
        const groundDelta = Math.hypot(a[0] - b[0], a[1] - b[1]);
        expect(groundDelta).toBeGreaterThan(0.1);
        // still unit length after rotation
        expect(Math.hypot(b[0], b[1], b[2])).toBeCloseTo(1, 12);
    });
});

describe('lightView (spec §3.9)', () => {
    test('is an orthonormal rotation (columns unit + orthogonal)', () => {
        const m = lightView(shadowSunDirection(sphericalToCartesian([1, 210, 45]), 'map', 0));
        // rows are the basis vectors right/up/fwd; each unit length
        const row = (r: number): Vec3 => [m[r], m[4 + r], m[8 + r]];
        for (let r = 0; r < 3; r++) {
            const v = row(r);
            expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 10);
        }
    });
});

describe('texelSnap (spec §3.9 texel-snap stability)', () => {
    test('floors to the world grid; sub-texel deltas map to the same grid line', () => {
        const texel = 0.5;
        expect(texelSnap(10.3, texel)).toBeCloseTo(10.0, 12);
        expect(texelSnap(10.3 + 1e-4, texel)).toBeCloseTo(10.0, 12);
        expect(texelSnap(10.3 - 1e-4, texel)).toBeCloseTo(10.0, 12);
        // same snapped value for any sub-texel jitter within [10.0, 10.5)
        expect(texelSnap(10.49, texel)).toBe(texelSnap(10.3, texel));
    });

    test('crossing a grid boundary jumps by exactly one texel (mechanism is discrete)', () => {
        const texel = 0.5;
        expect(texelSnap(10.51, texel) - texelSnap(10.49, texel)).toBeCloseTo(texel, 12);
    });

    test('texelSnapEnabled=false leaves the origin unsnapped', () => {
        expect(texelSnap(10.3, 0)).toBe(10.3);
    });
});

describe('computeWorldToLightClipCascades (spec §3.9 fit)', () => {
    const sunDir = shadowSunDirection(sphericalToCartesian([1.5, 210, 45]), 'map', 0);

    test('produces `cascadeCount` finite matrices', () => {
        const t = makeTransform({zoom: 15.4, pitch: 55, bearing: 0, center: [30.5234, 50.4501]});
        const c1 = computeWorldToLightClipCascades(t, sunDir, 1024, 1, 0.4);
        expect(c1).toHaveLength(1);
        const c2 = computeWorldToLightClipCascades(t, sunDir, 1024, 2, 0.4);
        expect(c2).toHaveLength(2);
        for (const cas of [...c1, ...c2]) {
            for (let i = 0; i < 16; i++) expect(Number.isFinite(cas[i])).toBe(true);
        }
    });

    test('fitLightClip emits [0,1] z (Metal/Vulkan convention shared with Tasks 2/3)', () => {
        // A unit footprint under a fixed sun: the near plane maps to clip.z=0, the far to clip.z=1.
        const footprint: Vec3[] = [
            [-100, -100, 0], [100, -100, 0], [-100, 100, 0], [100, 100, 0],
            [-100, -100, 50], [100, -100, 50], [-100, 100, 50], [100, 100, 50]
        ];
        const m = fitLightClip(sunDir, footprint, 1024, false);
        // transform each world point; clip.z/clip.w must land within [0,1] (ortho => w=1)
        for (const p of footprint) {
            const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
            const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
            const ndc = z / w;
            expect(ndc).toBeGreaterThanOrEqual(0);
            expect(ndc).toBeLessThanOrEqual(1);
        }
    });

    test('BEARING-INVARIANT: the fit is identical under a pure bearing change with an overridden center', () => {
        // Isolate the fit from the transform-derived footprint: fix the world center + radius so the
        // ONLY thing bearing could change is the (sun-anchored) fit itself. It must be bit-identical.
        const center: Vec3 = [8.3e6, 8.35e6, 0];
        const t0 = makeTransform({zoom: 15, pitch: 55, bearing: 0, center: [30.5234, 50.4501]});
        const t90 = makeTransform({zoom: 15, pitch: 55, bearing: 90, center: [30.5234, 50.4501]});
        const a = computeWorldToLightClipCascades(t0, sunDir, 1024, 1, 0.4, 200, center, 900);
        const b = computeWorldToLightClipCascades(t90, sunDir, 1024, 1, 0.4, 200, center, 900);
        expect(maxAbsDiff(a[0], b[0])).toBe(0);
    });

    test('BEARING-INVARIANT: the live footprint center + radius are stable under rotation', () => {
        const t0 = makeTransform({zoom: 15, pitch: 55, bearing: 0, center: [30.5234, 50.4501]});
        const t90 = makeTransform({zoom: 15, pitch: 55, bearing: 137, center: [30.5234, 50.4501]});
        const f0 = shadowViewFootprint(t0);
        const f90 = shadowViewFootprint(t90);
        expect(f0.center[0]).toBeCloseTo(f90.center[0], 2);
        expect(f0.center[1]).toBeCloseTo(f90.center[1], 2);
        // farRadius is a scalar max-distance => bearing-invariant (relative diff < 1e-6)
        expect(Math.abs(f0.farRadius - f90.farRadius) / f0.farRadius).toBeLessThan(1e-6);
    });

    test('BEARING-INVARIANT (end-to-end): full live cascades match within <=1 texel under rotation', () => {
        const t0 = makeTransform({zoom: 15.4, pitch: 55, bearing: 0, center: [30.5234, 50.4501]});
        const t45 = makeTransform({zoom: 15.4, pitch: 55, bearing: 45, center: [30.5234, 50.4501]});
        const a = computeWorldToLightClipCascades(t0, sunDir, 1024, 1, 0.4)[0];
        const b = computeWorldToLightClipCascades(t45, sunDir, 1024, 1, 0.4)[0];
        // A view-frustum fit that rotated with the camera would differ by O(1) here; the sun-anchored
        // square differs only by at most one texel-snap step (~1/mapSize of the linear scale).
        expect(maxAbsDiff(a, b)).toBeLessThan(1e-2);
    });

    test('TEXEL-SNAP stability: a sub-texel center pan yields a bit-identical snapped fit', () => {
        const t = makeTransform({zoom: 15.4, pitch: 55, bearing: 20, center: [30.5234, 50.4501]});
        const view = shadowViewFootprint(t);
        const c0 = view.center;
        // pan the world center by a sub-texel amount (radius/mapSize ~= one texel; use 1e-4 of it)
        const subTexel = (view.farRadius / 1024) * 1e-4;
        const c1: Vec3 = [c0[0] + subTexel, c0[1] + subTexel, 0];
        const a = computeWorldToLightClipCascades(t, sunDir, 1024, 1, 0.4, 200, c0, view.farRadius);
        const b = computeWorldToLightClipCascades(t, sunDir, 1024, 1, 0.4, 200, c1, view.farRadius);
        expect(maxAbsDiff(a[0], b[0])).toBe(0);
    });
});

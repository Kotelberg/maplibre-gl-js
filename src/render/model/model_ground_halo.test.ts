import {describe, expect, test} from 'vitest';
import {
    getGroundHaloImage,
    groundHaloPulse,
    GROUND_HALO_RADIUS_FACTOR,
    GROUND_HALO_LIFT_METERS,
    GROUND_HALO_BASE_INTENSITY,
    GROUND_HALO_PULSE_AMP,
    GROUND_HALO_PULSE_PERIOD_S,
    GROUND_HALO_RINGS,
    GROUND_HALO_COLOR
} from './model_ground_halo';

// The gold selection ground bullseye reproduces the MOBILE APP's ground cue:
// three nested #FDB912 `fill` discs (radii 105/85/68 m, opacity 0.08/0.14/0.20)
// breathing on a ~1.8 s sine — apps/mobile/.../model-buildings-layer.tsx
// (`GLOW_RINGS` + `PULSE_*`). These lock the ported profile/tuning to the app.

describe('getGroundHaloImage', () => {
    const image = getGroundHaloImage();
    const size = 256;
    const alphaAt = (x: number, y: number) => image.data[(y * size + x) * 4 + 3];

    test('is a 256x256 RGBA image', () => {
        expect(image.width).toBe(size);
        expect(image.height).toBe(size);
        expect(image.data.length).toBe(size * size * 4);
    });

    test('is a stepped bullseye: bright core, mid band, faint rim, transparent corners', () => {
        // Centre sits inside all three discs → the brightest, composited band
        // (α ≈ 0.37 · 255 = 94). At runtime the building occludes this core.
        expect(alphaAt(128, 128)).toBe(94);
        // Three concentric bands, brightest inward: core (r ≈ 0.50, x ≈ 192) >
        // mid (r ≈ 0.73, x ≈ 221, outer + middle discs) > rim (r ≈ 0.90, x ≈ 243,
        // outer disc only). The visible stepping is the "several disks" look.
        const core = alphaAt(192, 128);
        const mid = alphaAt(221, 128);
        const rim = alphaAt(243, 128);
        expect(core).toBe(94);
        expect(mid).toBe(53);
        expect(rim).toBe(20);
        expect(core).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(rim);
        // Corners (r ≈ 1.41 ≫ the outer disc at r = 1) → fully transparent, so the
        // square quad reads as nested discs with no hard box edge.
        expect(alphaAt(0, 0)).toBe(0);
        expect(alphaAt(size - 1, size - 1)).toBe(0);
    });

    test('peak alpha is the three-disc composite (≈ 0.37)', () => {
        let maxA = 0;
        for (let i = 3; i < image.data.length; i += 4) maxA = Math.max(maxA, image.data[i]);
        // 1 − (1−0.08)(1−0.14)(1−0.20) = 0.36704 → round(·255) = 94.
        expect(maxA).toBe(94);
    });

    test('is premultiplied gold everywhere (rgb <= alpha, gold ratios)', () => {
        for (let i = 0; i < image.data.length; i += 4) {
            const [r, g, b, a] = [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
            // Premultiplied: each channel is colour×alpha, and #FDB912 channels are ≤ 1.
            expect(r).toBeLessThanOrEqual(a);
            expect(g).toBeLessThanOrEqual(a);
            expect(b).toBeLessThanOrEqual(a);
            // Gold ordering R > G > B holds wherever there is any coverage.
            if (a > 4) {
                expect(r).toBeGreaterThanOrEqual(g);
                expect(g).toBeGreaterThanOrEqual(b);
            }
        }
    });

    test('rings match the mobile app GLOW_RINGS (outer→inner, fainter→brighter)', () => {
        expect(GROUND_HALO_RINGS).toEqual([
            {radius: 1.0, opacity: 0.08},
            {radius: 85 / 105, opacity: 0.14},
            {radius: 68 / 105, opacity: 0.20}
        ]);
    });

    test('colour constant is #FDB912', () => {
        expect(GROUND_HALO_COLOR).toEqual([0.992, 0.725, 0.071]);
    });
});

describe('groundHaloPulse', () => {
    test('matches the mobile pulse 1 + 0.35·sin(t·2π/1.8s)', () => {
        expect(groundHaloPulse(0)).toBeCloseTo(1.0, 6);         // midpoint (rest)
        expect(groundHaloPulse(0.45)).toBeCloseTo(1.35, 6);     // peak  (+35 %)
        expect(groundHaloPulse(0.9)).toBeCloseTo(1.0, 6);       // midpoint
        expect(groundHaloPulse(1.35)).toBeCloseTo(0.65, 6);     // trough (−35 %)
        expect(groundHaloPulse(1.8)).toBeCloseTo(1.0, 6);       // one full period
    });

    test('tuning constants match the mobile app', () => {
        expect(GROUND_HALO_RADIUS_FACTOR).toBe(1.7);
        expect(GROUND_HALO_LIFT_METERS).toBe(0.05);
        expect(GROUND_HALO_BASE_INTENSITY).toBe(1.0);
        expect(GROUND_HALO_PULSE_AMP).toBe(0.35);
        expect(GROUND_HALO_PULSE_PERIOD_S).toBe(1.8);
    });
});

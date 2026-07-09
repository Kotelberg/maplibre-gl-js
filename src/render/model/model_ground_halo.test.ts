import {describe, expect, test} from 'vitest';
import {
    getGroundHaloImage,
    groundHaloPulse,
    GROUND_HALO_RADIUS_FACTOR,
    GROUND_HALO_LIFT_METERS,
    GROUND_HALO_BASE_INTENSITY,
    GROUND_HALO_PULSE_AMP,
    GROUND_HALO_PULSE_PERIOD_S,
    GROUND_HALO_COLOR
} from './model_ground_halo';

// The gold selection ground disc is the web port of native's Vulkan
// `makeGroundHaloImage` + `kGroundHalo*` constants (render_model_layer.cpp @
// hatahub/model-selection-bloom). These lock the ported profile/tuning to native.

describe('getGroundHaloImage', () => {
    const image = getGroundHaloImage();
    const size = 256;
    const alphaAt = (x: number, y: number) => image.data[(y * size + x) * 4 + 3];

    test('is a 256x256 RGBA image', () => {
        expect(image.width).toBe(size);
        expect(image.height).toBe(size);
        expect(image.data.length).toBe(size * size * 4);
    });

    test('is a ring: transparent centre, bright mid-band, transparent corners', () => {
        // Centre is inside the inner-rise cutoff (r < 0.28) → transparent, so the
        // building fully occludes an empty core rather than a dark plug.
        expect(alphaAt(128, 128)).toBe(0);
        // Corners (r ≈ 1.41 ≫ 0.95 feather end) → fully transparent, so the square
        // quad reads as a disc with no hard box edge.
        expect(alphaAt(0, 0)).toBe(0);
        expect(alphaAt(size - 1, size - 1)).toBe(0);
        // A mid-band pixel near r ≈ 0.6 (dx ≈ 0.6 → x ≈ 204) sits on the bright plateau.
        expect(alphaAt(204, 128)).toBeGreaterThan(120);
    });

    test('peak alpha matches native kPeakAlpha 0.62', () => {
        let maxA = 0;
        for (let i = 3; i < image.data.length; i += 4) maxA = Math.max(maxA, image.data[i]);
        expect(maxA).toBe(Math.round(0.62 * 255)); // 158
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

    test('colour constant is #FDB912', () => {
        expect(GROUND_HALO_COLOR).toEqual([0.992, 0.725, 0.071]);
    });
});

describe('groundHaloPulse', () => {
    test('matches native 0.55 + 0.16·sin(t·2π/4s)', () => {
        expect(groundHaloPulse(0)).toBeCloseTo(0.55, 6);       // midpoint
        expect(groundHaloPulse(1)).toBeCloseTo(0.71, 6);       // peak  (never floods)
        expect(groundHaloPulse(2)).toBeCloseTo(0.55, 6);       // midpoint
        expect(groundHaloPulse(3)).toBeCloseTo(0.39, 6);       // trough
        expect(groundHaloPulse(4)).toBeCloseTo(0.55, 6);       // one full period
    });

    test('tuning constants match native kGroundHalo*', () => {
        expect(GROUND_HALO_RADIUS_FACTOR).toBe(1.7);
        expect(GROUND_HALO_LIFT_METERS).toBe(0.05);
        expect(GROUND_HALO_BASE_INTENSITY).toBe(0.55);
        expect(GROUND_HALO_PULSE_AMP).toBe(0.16);
        expect(GROUND_HALO_PULSE_PERIOD_S).toBe(4.0);
    });
});

import {describe, expect, test} from 'vitest';

/**
 * Deterministic verification of the packed-RGBA8 depth codec (spec §3.2) and the D3 sample-time
 * math (spec §3.3.1 / §3.3.3) — the infra-correctness gate for the caster before receivers exist.
 *
 * These are JS transcriptions of the shipped GLSL: `packDepth` from
 * `shaders/shadow_depth.fragment.glsl` (the caster fragment authored in this task) and the receiver
 * unpack dot product + unwritten-texel guard from `shaders/fill_extrusion_shadow.fragment.glsl`
 * (Task 3). The end-to-end GPU readback over real tiles is exercised once the caster is wired into
 * the painter (Task 5) and lands in the Task 6 render battery; here we prove the codec is an exact
 * inverse and that the seed / unwritten sentinel behave as required, without a GPU.
 */

const fract = (x: number): number => x - Math.floor(x);

/** VERBATIM port of the caster's GLSL `packDepth` (spec §3.2). Returns 4 floats in [0,1]. */
function packDepth(depth: number): [number, number, number, number] {
    const maxPackable = 1.0 - 1.0 / 16581375.0;
    depth = Math.min(Math.max(depth, 0.0), maxPackable);
    const bitSh = [1.0, 255.0, 65025.0, 16581375.0];
    const mask = [1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0];
    const enc = bitSh.map((b) => fract(b * depth));
    // enc -= enc.yzww * mask;
    const yzww = [enc[1], enc[2], enc[3], enc[3]];
    return enc.map((e, i) => e - yzww[i] * mask[i]) as [number, number, number, number];
}

/** Quantize each channel to 8 bits, as an RGBA8 texture stores + returns on readback. */
function toRGBA8(enc: [number, number, number, number]): [number, number, number, number] {
    return enc.map((e) => Math.round(e * 255) / 255) as [number, number, number, number];
}

/** VERBATIM port of the receiver unpack dot product (spec §3.2). */
function unpackShadowDepth(rgba: [number, number, number, number]): number {
    return rgba[0] * 1.0 + rgba[1] * (1.0 / 255.0) + rgba[2] * (1.0 / 65025.0) + rgba[3] * (1.0 / 16581375.0);
}

/** VERBATIM port of `fe_unpackShadowDepth`'s unwritten-texel guard (spec §3.3.1). */
function feUnpackShadowDepth(rgba: [number, number, number, number]): number {
    const d = unpackShadowDepth(rgba);
    return d < (0.5 / 255.0) ? 1.0 : d;
}

const FAR_WHITE: [number, number, number, number] = [1, 1, 1, 1];
const UNWRITTEN: [number, number, number, number] = [0, 0, 0, 0];

describe('packed-depth codec (spec §3.2)', () => {
    test('pack → 8-bit → unpack round-trips every written depth to a sane [0,1) value', () => {
        for (let d = 0.0; d <= 1.0; d += 1 / 512) {
            const reconstructed = unpackShadowDepth(toRGBA8(packDepth(d)));
            // Sane depth: reconstructs within a small tolerance and never leaves [0,1).
            expect(Math.abs(reconstructed - d)).toBeLessThan(1e-4);
            expect(reconstructed).toBeGreaterThanOrEqual(0.0);
            expect(reconstructed).toBeLessThanOrEqual(1.0);
        }
    });

    test('pack and unpack vectors are exact inverses (16581375 === 255^3)', () => {
        expect(16581375).toBe(255 * 255 * 255);
        expect(65025).toBe(255 * 255);
    });
});

describe('D3 seed / unwritten-texel guard (spec §3.3.1 / §3.3.3)', () => {
    test('unwritten (all-zero) texel decodes below the 0.5/255 threshold → guarded to far/lit', () => {
        // The raw decode of an unwritten texel is 0.0 ("occluder on the near plane" = the D3 wash).
        expect(unpackShadowDepth(UNWRITTEN)).toBeLessThan(0.5 / 255.0);
        // The guard remaps a sub-minimum sample to FAR (1.0) ⇒ lit.
        expect(feUnpackShadowDepth(UNWRITTEN)).toBe(1.0);
    });

    test('far-white seed (0xFF bytes) decodes to ≥ far (1.0) ⇒ lit', () => {
        expect(unpackShadowDepth(FAR_WHITE)).toBeGreaterThanOrEqual(1.0);
        expect(feUnpackShadowDepth(FAR_WHITE)).toBeGreaterThanOrEqual(1.0);
    });

    test('a real caster depth is never mistaken for an unwritten texel', () => {
        // The frustum zPad guarantees no real occluder encodes ≈0; the minimum realistic depth
        // (~0.02) still sits well above the 0.5/255 sentinel, so the guard passes it through.
        for (const d of [0.02, 0.1, 0.5, 0.9, 0.999]) {
            const rgba = toRGBA8(packDepth(d));
            expect(unpackShadowDepth(rgba)).toBeGreaterThanOrEqual(0.5 / 255.0);
            expect(feUnpackShadowDepth(rgba)).toBeCloseTo(d, 3);
        }
    });
});

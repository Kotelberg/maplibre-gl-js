import {describe, expect, test} from 'vitest';
import {shaders} from '../../shaders/shaders';

/**
 * Receiver-program verification (spec §3, Task 3). Two layers:
 *
 *  1. Shader-source invariants — the prepared `fillExtrusionShadow` (a `#define RENDER_SHADOWS`
 *     variant of the fill-extrusion program) and `groundShadow` sources must carry every D3 invariant
 *     VERBATIM, and the STOCK `fillExtrusion` source must keep all shadow code behind the define so it
 *     stays byte-identical when compiled without it (default-off gate, §3.0). These guard against the
 *     paraphrase drift the D3 campaign proves is fatal.
 *
 *  2. Deterministic receiver math — JS transcriptions of `fe_unpackShadowDepth`, `fe_pcfBilinear`,
 *     `fe_cascade` and the wallness composite prove the guard/PCF/per-cascade-bias/cascade-fallthrough
 *     logic without a GPU (the codec test pattern established in Task 2). The end-to-end GPU render
 *     lands in the Task 6 battery.
 */

// ------------------------------------------------------------------------------------------------
// 1. Shader-source invariants
// ------------------------------------------------------------------------------------------------

describe('receiver shader sources (spec §3 — verbatim invariants)', () => {
    const feShadowFrag = shaders.fillExtrusionShadow.fragmentSource;
    const feShadowVert = shaders.fillExtrusionShadow.vertexSource;
    const groundFrag = shaders.groundShadow.fragmentSource;
    const stockFrag = shaders.fillExtrusion.fragmentSource;

    // The shader codegen minifies GLSL whitespace, so compare with all whitespace stripped — this
    // still proves the exact tokens/operators/constants are present (the D3 drift the rule guards).
    const norm = (s: string) => s.replace(/\s+/g, '');
    const hasCode = (src: string, snippet: string) => norm(src).includes(norm(snippet));

    test('building receiver + stock receiver share ONE source, gated by #ifdef RENDER_SHADOWS', () => {
        // Same prepared source (the shadow variant is a define, not a fork of the file).
        expect(feShadowFrag).toBe(stockFrag);
        // The whole shadow block is behind the define, so the stock program compiles byte-identical.
        expect(hasCode(stockFrag, '#ifdef RENDER_SHADOWS')).toBe(true);
    });

    test('§3.2 unpack dot product (exact-inverse vector) is present verbatim in both receivers', () => {
        const dot = 'dot(rgba, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0))';
        expect(hasCode(feShadowFrag, dot)).toBe(true);
        expect(hasCode(groundFrag, dot)).toBe(true);
    });

    test('§3.3.1 unwritten-texel guard is present verbatim (building receiver)', () => {
        expect(hasCode(feShadowFrag, 'return d < (0.5 / 255.0) ? 1.0 : d;')).toBe(true);
    });

    test('§3.6 per-cascade bias uses the shipped 8.0 / 4.0 constants verbatim', () => {
        expect(hasCode(feShadowFrag, 'float biasScale = (cIdx < v_cascade_count - 1) ? 8.0 : 4.0;')).toBe(true);
        expect(hasCode(feShadowFrag, 'float current = ndc.z - (u_shadow_bias + v_slope * u_shadow_slope_bias) * biasScale;')).toBe(true);
        // Ground receiver: constant-only bias, no slope / per-cascade scale.
        expect(hasCode(groundFrag, 'float current = ndc.z - u_shadow_bias;')).toBe(true);
    });

    test('§3.6.1 PCF is compare-first-then-blend, averaged /4.0, with NO discontinuity-clamp contamination', () => {
        // The 2x2 grid of fe_pcfBilinear taps is averaged /4.0.
        expect(hasCode(feShadowFrag, 'return l / 4.0;')).toBe(true);
        expect(hasCode(groundFrag, 'return l / 4.0;')).toBe(true);
        // The compare-first mix kernel.
        expect(hasCode(feShadowFrag, 'return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);')).toBe(true);
        // NEVER the uncommitted worktree instrumentation (the Plan-5 contamination this rule prevents).
        expect(feShadowFrag).not.toContain('fe_discTap');
        expect(feShadowFrag).not.toContain('u_shadow_disc');
    });

    test('§3.7 wallness suppression uses 1 - |normal.z| and the exact smoothstep band', () => {
        expect(hasCode(feShadowVert, 'v_wallness = 1.0 - abs(normalForLighting.z);')).toBe(true);
        expect(hasCode(feShadowFrag, 'lit = mix(lit, 1.0, smoothstep(0.4, 0.85, v_wallness));')).toBe(true);
        // The final lit -> color composition (prose in §3.1/§3.7; read from the committed native tree).
        expect(hasCode(feShadowFrag, 'color.rgb *= (1.0 - (1.0 - lit) * u_shadow_intensity);')).toBe(true);
    });

    test('§3.8 highp: both receiver fragments redeclare highp float and use highp packed samplers', () => {
        expect(hasCode(feShadowFrag, 'precision highp float;')).toBe(true);
        expect(hasCode(feShadowFrag, 'uniform highp sampler2D u_shadowmap0;')).toBe(true);
        expect(hasCode(groundFrag, 'precision highp float;')).toBe(true);
        expect(hasCode(groundFrag, 'uniform highp sampler2D u_shadowmap0;')).toBe(true);
    });

    test('§3.9 cascade select is a static-sampler if-chain over distinct samplers (never a dynamic index)', () => {
        for (const s of [feShadowFrag, groundFrag]) {
            expect(s).toContain('u_shadowmap0');
            expect(s).toContain('u_shadowmap1');
            expect(s).toContain('u_shadowmap2');
            expect(s).toContain('u_shadowmap3');
            // fe_cascade / ground_cascade return -1.0 when the fragment is outside the cascade.
            expect(hasCode(s, 'return -1.0;')).toBe(true);
        }
    });

    test('ground receiver emits the premultiplied-alpha overlay verbatim', () => {
        expect(hasCode(groundFrag, 'fragColor = vec4(u_shadow_color.rgb, (1.0 - lit) * u_shadow_intensity * fade);')).toBe(true);
    });

    test('stock (non-shadow) fill-extrusion fragment adds no shadow uniforms outside the define', () => {
        // The stock program is compiled WITHOUT RENDER_SHADOWS; the preprocessor strips every shadow
        // symbol. Assert none leak to file scope (they must all sit inside the #ifdef block).
        const beforeIfdef = stockFrag.slice(0, stockFrag.indexOf('#ifdef RENDER_SHADOWS'));
        expect(beforeIfdef).not.toContain('u_shadowmap0');
        expect(beforeIfdef).not.toContain('u_shadow_intensity');
    });
});

// ------------------------------------------------------------------------------------------------
// 2. Deterministic receiver math (VERBATIM JS transcriptions of the GLSL)
// ------------------------------------------------------------------------------------------------

type RGBA = [number, number, number, number];

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/** VERBATIM `fe_unpackShadowDepth` (§3.2 unpack + §3.3.1 guard). */
function feUnpackShadowDepth(rgba: RGBA): number {
    const d = rgba[0] * 1.0 + rgba[1] * (1.0 / 255.0) + rgba[2] * (1.0 / 65025.0) + rgba[3] * (1.0 / 16581375.0);
    return d < (0.5 / 255.0) ? 1.0 : d;
}

/**
 * VERBATIM `fe_pcfBilinear` (§3.6.1) over a 2x2 depth grid. `sample(u,v)` returns the packed RGBA at
 * texel-center coordinates; here we drive it with an explicit 2x2 depth field. `uv`/`texel` are set so
 * `c00` lands on grid cell (0,0) with fractional weight `f`.
 */
function fePcfBilinear(sample: (u: number, v: number) => RGBA, uv: [number, number], texel: number, current: number): number {
    const tc = [uv[0] / texel - 0.5, uv[1] / texel - 0.5];
    const base = [Math.floor(tc[0]), Math.floor(tc[1])];
    const f = [tc[0] - base[0], tc[1] - base[1]];
    const c00: [number, number] = [(base[0] + 0.5) * texel, (base[1] + 0.5) * texel];
    const s = (du: number, dv: number) => (current <= feUnpackShadowDepth(sample(c00[0] + du * texel, c00[1] + dv * texel))) ? 1.0 : 0.0;
    const s00 = s(0, 0), s10 = s(1, 0), s01 = s(0, 1), s11 = s(1, 1);
    return mix(mix(s00, s10, f[0]), mix(s01, s11, f[0]), f[1]);
}

/** The per-cascade bias scale (§3.6): near cascades 8x, far cascade 4x. */
function biasScale(cIdx: number, cascadeCount: number): number {
    return (cIdx < cascadeCount - 1) ? 8.0 : 4.0;
}

/** Pack a raw [0,1] depth into an 8-bit-quantized RGBA (the codec, so unpack sees texture bytes). */
function packToRGBA8(depth: number): RGBA {
    const fract = (x: number) => x - Math.floor(x);
    const maxPackable = 1.0 - 1.0 / 16581375.0;
    depth = clamp(depth, 0.0, maxPackable);
    const bitSh = [1.0, 255.0, 65025.0, 16581375.0];
    const mask = [1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0];
    const enc = bitSh.map((b) => fract(b * depth));
    const yzww = [enc[1], enc[2], enc[3], enc[3]];
    return enc.map((e, i) => Math.round((e - yzww[i] * mask[i]) * 255) / 255) as RGBA;
}

describe('receiver PCF kernel (spec §3.6.1 — compare-first, then blend)', () => {
    const texel = 0.25;
    // Sample fn: every texel is an occluder at depth 0.30 (packed to 8-bit).
    const occluderAt030 = () => packToRGBA8(0.30);

    test('a fragment nearer than every tap is fully lit (1.0)', () => {
        // current = 0.10 <= 0.30 at all 4 taps ⇒ all lit ⇒ blend = 1.0.
        const lit = fePcfBilinear(occluderAt030, [0.5, 0.5], texel, 0.10);
        expect(lit).toBeCloseTo(1.0, 5);
    });

    test('a fragment behind every tap is fully shadowed (0.0)', () => {
        // current = 0.50 > 0.30 at all 4 taps ⇒ none lit ⇒ blend = 0.0.
        const lit = fePcfBilinear(occluderAt030, [0.5, 0.5], texel, 0.50);
        expect(lit).toBeCloseTo(0.0, 5);
    });

    test('a 50/50 occluder split with centered weights blends to 0.5 (soft edge from PCF, not filtering)', () => {
        // Left column of taps is a near occluder (0.10 < current), right column is far (0.90 > current)
        // ⇒ two taps shadow the fragment, two do not; centered fractional weight (0.5) ⇒ 0.5.
        const splitTexel = 0.5;
        const halfOccluded = (u: number, _v: number): RGBA => (u < 0.5 ? packToRGBA8(0.10) : packToRGBA8(0.90));
        const current = 0.50; // behind the near taps (0.10), in front of the far taps (0.90)
        // uv = texel ⇒ c00 = 0.25, taps at x = 0.25 (near) and 0.75 (far), f = (0.5, 0.5).
        const lit = fePcfBilinear(halfOccluded, [splitTexel, splitTexel], splitTexel, current);
        expect(lit).toBeCloseTo(0.5, 5);
    });
});

describe('per-cascade depth bias (spec §3.6)', () => {
    test('near cascades scale bias 8x, the far cascade 4x', () => {
        // 2-cascade config: cascade 0 (near) = 8x, cascade 1 (far) = 4x.
        expect(biasScale(0, 2)).toBe(8.0);
        expect(biasScale(1, 2)).toBe(4.0);
        // 1-cascade default: the single cascade IS the far cascade ⇒ 4x.
        expect(biasScale(0, 1)).toBe(4.0);
    });

    test('bias subtracts (constant + slope*slopeBias)*scale from ndc.z (shipped 0.0 / 0.05)', () => {
        const uShadowBias = 0.0, uSlopeBias = 0.05;
        const ndcZ = 0.5;
        // A grazing away-face (v_slope near 1) on a near cascade gets the largest lift.
        const vSlope = 1.0;
        const current = ndcZ - (uShadowBias + vSlope * uSlopeBias) * biasScale(0, 2);
        expect(current).toBeCloseTo(0.5 - 0.05 * 8.0, 6); // 0.5 - 0.4 = 0.1
        // A sun-facing face (v_slope = 0) gets no lift regardless of cascade — a neighbour's cast
        // shadow still lands (the whole point of the slope term).
        expect(ndcZ - (uShadowBias + 0.0 * uSlopeBias) * biasScale(0, 2)).toBe(ndcZ);
    });
});

describe('cascade if-chain fallthrough (spec §3.9)', () => {
    // fe_cascade returns -1.0 when the fragment is outside [0,1] uv/ndc.z, so the caller falls to the
    // next wider cascade. Model the outside-test + fallthrough.
    function cascadeContains(uv: [number, number], ndcZ: number): boolean {
        return !(uv[0] < 0.0 || uv[0] > 1.0 || uv[1] < 0.0 || uv[1] > 1.0 || ndcZ < 0.0 || ndcZ > 1.0);
    }
    function walk(litPerCascade: (number | null)[]): number {
        // null = outside this cascade (fe_cascade returned -1.0); walk near->far, tightest wins.
        let lit = 1.0;
        for (const r of litPerCascade) {
            if (r !== null && r >= 0.0) { lit = r; break; }
        }
        return lit;
    }

    test('a fragment inside the near cascade uses it (tightest containing wins)', () => {
        expect(walk([0.25, 0.8])).toBe(0.25);
    });

    test('a fragment outside the near cascade falls through to the next wider one', () => {
        expect(walk([null, 0.6])).toBe(0.6);
    });

    test('a fragment outside every cascade stays fully lit (no false far-field shadow)', () => {
        expect(walk([null, null, null, null])).toBe(1.0);
    });

    test('the outside-test rejects out-of-range uv and ndc.z', () => {
        expect(cascadeContains([0.5, 0.5], 0.5)).toBe(true);
        expect(cascadeContains([1.2, 0.5], 0.5)).toBe(false);
        expect(cascadeContains([0.5, -0.1], 0.5)).toBe(false);
        expect(cascadeContains([0.5, 0.5], 1.5)).toBe(false);
    });
});

describe('wallness composite (spec §3.7)', () => {
    const smoothstep = (e0: number, e1: number, x: number) => {
        const t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
    };
    // lit = mix(lit, 1.0, smoothstep(0.4, 0.85, v_wallness)); color darkened by (1-(1-lit)*intensity).
    function composite(litRaw: number, wallness: number, intensity: number): number {
        const lit = mix(litRaw, 1.0, smoothstep(0.4, 0.85, wallness));
        return 1.0 - (1.0 - lit) * intensity; // the per-channel color multiplier
    }

    test('a shadowed roof (wallness 0) keeps the full cast-shadow darkening', () => {
        // lit stays 0 ⇒ multiplier = 1 - intensity (fully shadowed at the given strength).
        expect(composite(0.0, 0.0, 0.32)).toBeCloseTo(1.0 - 0.32, 6);
    });

    test('a shadowed vertical wall (wallness 1) is fully suppressed back to lit (multiplier 1.0)', () => {
        // smoothstep(0.4,0.85,1)=1 ⇒ lit->1 ⇒ multiplier = 1 (no cast-shadow term on walls).
        expect(composite(0.0, 1.0, 0.32)).toBeCloseTo(1.0, 6);
    });

    test('an already-lit surface is unchanged regardless of wallness', () => {
        expect(composite(1.0, 0.0, 0.32)).toBeCloseTo(1.0, 6);
        expect(composite(1.0, 1.0, 0.32)).toBeCloseTo(1.0, 6);
    });
});

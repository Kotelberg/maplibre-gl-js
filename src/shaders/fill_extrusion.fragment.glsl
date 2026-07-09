in vec4 v_color;

#ifdef RENDER_SHADOWS
// Building shadow-receiver variant (spec §3). Every sample-time behavior below is transcribed
// VERBATIM from the committed native shader shaders/fill_extrusion_shadow.fragment.glsl @ 657952f4
// (the "D3" invariant family — codec/guard/PCF/bias/wallness/cascade). Do NOT paraphrase or
// "clean up": paraphrase reintroduces the shipped grey-roof bugs (§3 Global Constraints).
//
// highp everywhere (§3.8): WebGL2 GLSL ES 3.00 defaults the fragment shader to mediump, which
// cannot represent the packed-depth codec or city-scale light-clip coordinates without banding /
// collapse -> shadow acne / plateaus that look like bias bugs. This redeclaration is inside the
// RENDER_SHADOWS variant only, so the stock fill-extrusion fragment stays byte-identical (§3.0).
precision highp float;

in highp vec4 v_shadow_pos[4];
in highp float v_slope;
in highp float v_wallness;
flat in int v_cascade_count;

uniform highp float u_shadow_intensity;
uniform highp float u_shadow_texel_size;
uniform highp float u_shadow_bias;
uniform highp float u_shadow_slope_bias;

// Per-cascade packed-depth maps, near->far. ES 3.0 cannot index a sampler array by a runtime
// variable, so the cascade walk is a static-sampler if-chain (§3.9); these are distinct samplers.
uniform highp sampler2D u_shadowmap0;
uniform highp sampler2D u_shadowmap1;
uniform highp sampler2D u_shadowmap2;
uniform highp sampler2D u_shadowmap3;

// §3.2 unpack + §3.3.1 unwritten-texel guard — VERBATIM from native :28-40.
float fe_unpackShadowDepth(vec4 rgba) {
    float d = dot(rgba, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0));
    // Unwritten shadow-map texels read all-zero == packed depth 0.0 (the light's near plane). The map
    // is seeded + cleared to white (far, 1.0) so "no caster" reads lit, but a texel the caster pass
    // never populated for the sampled image can still read 0.0 on some backends, and 0.0 compares
    // NEARER than every roof -> the entire far field is wrongly shadowed (the grey-roof "D3"
    // artifact). ShadowFrustum::fit pads the ortho near plane BELOW the tallest caster (zPad), so no
    // real occluder ever encodes depth ~0; treat a ~0 texel as FAR so an unwritten sample never
    // occludes. Behaviour-identical for every real caster (ndc.z >= ~0.02) and the white far seed
    // (1.0); only the all-zero sentinel is remapped. REQUIRED in every receiver that samples the map.
    return d < (0.5 / 255.0) ? 1.0 : d;
}

// Bilinear percentage-closer filter: compare the 4 texels around `uv`, then bilinearly blend the
// 0/1 results. The map stores RGBA8-PACKED depth (NEAREST-sampled, §3.3.2), so we must compare
// FIRST, then blend — bilinear filtering of packed bytes is meaningless. VERBATIM from native :44-54
// (§3.6.1). No fe_discTap / u_shadow_disc — that was uncommitted worktree instrumentation.
float fe_pcfBilinear(highp sampler2D tex, highp vec2 uv, float texel, float current) {
    highp vec2 tc = uv / texel - 0.5;
    highp vec2 base = floor(tc);
    highp vec2 f = tc - base;
    highp vec2 c00 = (base + 0.5) * texel;
    float s00 = (current <= fe_unpackShadowDepth(texture(tex, c00))) ? 1.0 : 0.0;
    float s10 = (current <= fe_unpackShadowDepth(texture(tex, c00 + vec2(texel, 0.0)))) ? 1.0 : 0.0;
    float s01 = (current <= fe_unpackShadowDepth(texture(tex, c00 + vec2(0.0, texel)))) ? 1.0 : 0.0;
    float s11 = (current <= fe_unpackShadowDepth(texture(tex, c00 + vec2(texel, texel)))) ? 1.0 : 0.0;
    return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// Returns lit in [0,1] when this cascade contains the fragment, or -1.0 when it doesn't (so the
// caller falls through to the next, wider cascade). VERBATIM from native :58-79 (§3.6 bias + §3.9).
float fe_cascade(highp sampler2D tex, highp vec4 sp, int cIdx) {
    highp vec3 ndc = sp.xyz / sp.w;
    highp vec2 uv = ndc.xy * 0.5 + 0.5; // GL bottom-left origin: no uv.y flip (unlike Metal)
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
        return -1.0;
    }
    // Bias scale (§3.6, retuned): a single 4.0 for every cascade. Native's per-cascade 8.0 (near) /
    // 4.0 (far) pair was backwards for concentric cascades — the near cascade has ~2.5x the texel
    // density of the far one (radius = far * split), so it needs LESS bias headroom, not 2x more.
    // Because the receiver bias is a fraction of the light frustum's depth extent (screen-bounded,
    // ~zoom-invariant in world px) while caster/receiver depth separation grows as 2^zoom, every
    // excess bias factor directly delays the zoom at which a neighbour's shadow can land on a roof.
    // Measured (debug onset harness, two-tower scene, polar 10-80, z14.5-18, pitch 0/55): 4.0 with
    // the 0.001/0.005 bias pair is acne-free everywhere and onsets together with the ground receiver.
    float biasScale = 4.0;
    float current = ndc.z - (u_shadow_bias + v_slope * u_shadow_slope_bias) * biasScale;
    float l = 0.0;
    for (int dy = 0; dy <= 1; ++dy) {
        for (int dx = 0; dx <= 1; ++dx) {
            l += fe_pcfBilinear(
                tex, uv + (vec2(float(dx), float(dy)) - 0.5) * u_shadow_texel_size, u_shadow_texel_size, current);
        }
    }
    return l / 4.0;
}
#endif

void main() {
    fragColor = v_color;

#ifdef RENDER_SHADOWS
    highp vec4 color = v_color;

    // CASCADED SHADOW MAPS: tightest containing cascade wins (hard transition). ES 3.0 cannot index a
    // sampler array by a loop variable, so the near->far walk is an explicit static-sampler if-chain
    // (§3.9). Do NOT "clean up" into a dynamically-indexed sampler array — WebGL2 forbids it.
    // VERBATIM from native :83-108.
    float lit = 1.0;
    float r = -1.0;
    if (v_cascade_count > 0) {
        r = fe_cascade(u_shadowmap0, v_shadow_pos[0], 0);
        if (r >= 0.0) {
            lit = r;
        } else if (v_cascade_count > 1) {
            r = fe_cascade(u_shadowmap1, v_shadow_pos[1], 1);
            if (r >= 0.0) {
                lit = r;
            } else if (v_cascade_count > 2) {
                r = fe_cascade(u_shadowmap2, v_shadow_pos[2], 2);
                if (r >= 0.0) {
                    lit = r;
                } else if (v_cascade_count > 3) {
                    r = fe_cascade(u_shadowmap3, v_shadow_pos[3], 3);
                    if (r >= 0.0) {
                        lit = r;
                    }
                }
            }
        }
    }

    // Suppress the (projective-aliased) cast shadow on near-vertical walls; keep it on roofs (§3.7).
    // Walls keep their normal directional face-shading (already baked into v_color); only the broken
    // cast-shadow term is faded back to fully-lit. VERBATIM from native :110-112.
    lit = mix(lit, 1.0, smoothstep(0.4, 0.85, v_wallness));
    color.rgb *= (1.0 - (1.0 - lit) * u_shadow_intensity);
    fragColor = color;
#endif

    #ifdef OVERDRAW_INSPECTOR
        fragColor = vec4(1.0);
    #endif
}

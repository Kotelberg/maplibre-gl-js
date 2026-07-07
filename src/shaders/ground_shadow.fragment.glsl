// Ground shadow-receiver fragment shader (spec §3.1). Transcribed VERBATIM from the committed native
// shader shaders/ground_shadow.fragment.glsl @ 657952f4. Shares the building receiver's D3
// invariants — the same packed-depth unpack, the same compare-first-then-blend PCF kernel, the same
// static-sampler cascade if-chain — but has its OWN, simpler bias (constant only, no slope /
// per-cascade scale, §3.6) and emits a premultiplied-alpha shadow overlay instead of multiplying a
// building color.
//
// highp everywhere (§3.8): WebGL2 defaults the fragment shader to mediump, which collapses the codec.
precision highp float;

in highp vec4 v_shadow_pos[4];
in highp float v_view_w;
flat in int v_cascade_count;

uniform highp vec4 u_shadow_color;
uniform highp float u_shadow_intensity;
uniform highp float u_shadow_texel_size;
uniform highp float u_shadow_bias;
uniform highp float u_shadow_fade_start;
uniform highp float u_depth_fade_start;
uniform highp float u_depth_fade_end;

uniform highp sampler2D u_shadowmap0;
uniform highp sampler2D u_shadowmap1;
uniform highp sampler2D u_shadowmap2;
uniform highp sampler2D u_shadowmap3;

// §3.2 unpack. The ground receiver samples the SAME packed map as the building receiver. Note it
// carries NO unwritten-texel remap of its own; the ground overlay is edge/depth-faded (below) and
// only draws where a cascade contains the fragment, so the D3 near-plane sentinel does not surface
// here. VERBATIM from native :24-26.
float ground_unpackShadowDepth(vec4 rgba) {
    return dot(rgba, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0));
}

// Near->far view-distance fade so the ground overlay dissolves toward the frustum's far edge.
// VERBATIM from native :28-33.
float ground_depthFade(float view_w, float fade_start, float fade_end) {
    if (fade_end <= 0.0 || fade_end <= fade_start) {
        return 1.0;
    }
    return 1.0 - smoothstep(fade_start, fade_end, view_w);
}

// Same compare-first-then-blend PCF as the building receiver, sampling ground_unpackShadowDepth
// (§3.6.1). VERBATIM from native :35-45.
float ground_pcfBilinear(highp sampler2D tex, highp vec2 uv, float texel, float current) {
    highp vec2 tc = uv / texel - 0.5;
    highp vec2 base = floor(tc);
    highp vec2 f = tc - base;
    highp vec2 c00 = (base + 0.5) * texel;
    float s00 = (current <= ground_unpackShadowDepth(texture(tex, c00))) ? 1.0 : 0.0;
    float s10 = (current <= ground_unpackShadowDepth(texture(tex, c00 + vec2(texel, 0.0)))) ? 1.0 : 0.0;
    float s01 = (current <= ground_unpackShadowDepth(texture(tex, c00 + vec2(0.0, texel)))) ? 1.0 : 0.0;
    float s11 = (current <= ground_unpackShadowDepth(texture(tex, c00 + vec2(texel, texel)))) ? 1.0 : 0.0;
    return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// Returns lit in [0,1] when this cascade contains the fragment, or -1.0 when it doesn't. Ground bias
// is constant-only: `current = ndc.z - u_shadow_bias` (no slope / per-cascade scale, §3.6). VERBATIM
// from native :47-61.
float ground_cascade(highp sampler2D tex, highp vec4 sp) {
    highp vec3 ndc = sp.xyz / sp.w;
    highp vec2 uv = ndc.xy * 0.5 + 0.5; // GL bottom-left origin: no uv.y flip
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
        return -1.0;
    }
    float current = ndc.z - u_shadow_bias;
    float l = 0.0;
    for (int dy = 0; dy <= 1; ++dy) {
        for (int dx = 0; dx <= 1; ++dx) {
            l += ground_pcfBilinear(
                tex, uv + (vec2(float(dx), float(dy)) - 0.5) * u_shadow_texel_size, u_shadow_texel_size, current);
        }
    }
    return l / 4.0;
}

void main() {
    int lastCascade = max(v_cascade_count - 1, 0);
    // UV-radial (frustum-edge) fade tied to the FAR cascade — the OUTER coverage boundary.
    highp vec4 farSp = v_shadow_pos[lastCascade];
    highp vec3 farNdc = farSp.xyz / farSp.w;
    highp vec2 farUv = farNdc.xy * 0.5 + 0.5; // no uv.y flip on GL
    float r = max(abs(farUv.x - 0.5), abs(farUv.y - 0.5)) * 2.0;
    float uvFade = 1.0 - smoothstep(u_shadow_fade_start, 1.0, r);
    float depthFade = ground_depthFade(v_view_w, u_depth_fade_start, u_depth_fade_end);
    float fade = uvFade * depthFade;

    // Tightest containing cascade wins; static-sampler if-chain (§3.9; ES 3.0 has no dynamic sampler
    // index). VERBATIM from native :77-99.
    float lit = 1.0;
    float res = -1.0;
    if (v_cascade_count > 0) {
        res = ground_cascade(u_shadowmap0, v_shadow_pos[0]);
        if (res >= 0.0) {
            lit = res;
        } else if (v_cascade_count > 1) {
            res = ground_cascade(u_shadowmap1, v_shadow_pos[1]);
            if (res >= 0.0) {
                lit = res;
            } else if (v_cascade_count > 2) {
                res = ground_cascade(u_shadowmap2, v_shadow_pos[2]);
                if (res >= 0.0) {
                    lit = res;
                } else if (v_cascade_count > 3) {
                    res = ground_cascade(u_shadowmap3, v_shadow_pos[3]);
                    if (res >= 0.0) {
                        lit = res;
                    }
                }
            }
        }
    }

    // Premultiplied-alpha shadow overlay: rgb = shadow color (default black), alpha = shadow coverage
    // faded to the frustum edge. VERBATIM from native :101. With the default black shadow color,
    // premultiplied and straight alpha are identical (0 * a == 0); the ground draw uses premultiplied
    // alpha blending (spec §3.1). Do NOT premultiply here — transcribe the shipped output.
    fragColor = vec4(u_shadow_color.rgb, (1.0 - lit) * u_shadow_intensity * fade);
}

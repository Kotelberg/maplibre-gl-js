// Fork-internal (HataHub): the model selection-bloom composite fragment shader.
// A from-scratch web reimplementation of native `model_bloom.fragment.glsl`
// (maplibre-native b5a5db128be0) — same algorithm and tuning constants: a
// half-res white silhouette mask → 16-tap × 3-ring disk blur → premultiplied
// #FDB912 halo that HUGS the silhouette. highp is required: the mediump GLSL ES
// 3.00 fragment default bands the accumulated blur and the pow() falloff.
uniform sampler2D u_image;
// rgb = glow colour (#FDB912), a = breathing intensity (0.62 ± 0.34).
uniform highp vec4 u_color;
// 1.0 / mask size, so u_radius steps are in mask texels.
uniform highp vec2 u_texel;
// Blur radius in mask texels (native kBloomRadiusTexels = 7).
uniform highp float u_radius;

in highp vec2 v_uv;

void main() {
    // The mask target clears to opaque black (0,0,0,1) and the silhouette is
    // drawn solid white, so coverage lives in the RED channel.
    highp float mask = texture(u_image, v_uv).r;

    // Wide three-ring disk blur of the silhouette coverage for a soft,
    // atmospheric falloff (16 taps × 3 rings = 48 samples).
    highp float blur = 0.0;
    for (int i = 0; i < 16; i++) {
        highp float ang = (float(i) / 16.0) * 6.2831853;
        highp vec2 dir = vec2(cos(ang), sin(ang)) * u_texel * u_radius;
        blur += texture(u_image, v_uv + dir).r;
        blur += texture(u_image, v_uv + dir * 0.66).r;
        blur += texture(u_image, v_uv + dir * 0.33).r;
    }
    blur /= 48.0;

    // Outer glow gated to OUTSIDE the geometry. Multiplicative (1 - mask) gating
    // (vs. blur - mask) leaves no dead-band between the model edge and the glow,
    // and never tints the model itself.
    highp float halo = clamp(blur * (1.0 - mask) * 1.9, 0.0, 1.0);
    halo = pow(halo, 0.9);

    // Premultiplied-alpha output: the halo TINTS the scene toward the glow colour
    // (reads on a bright basemap) instead of merely brightening it.
    highp float a = halo * u_color.a;
    fragColor = vec4(u_color.rgb * a, a);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(0.0);
#endif
}

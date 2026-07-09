// Shadow caster fragment shader: packs the [0,1] light-space depth into RGBA8 color.
//
// highp everywhere (spec §3.8): WebGL2 GLSL ES 3.00 defaults the fragment shader to mediump, which
// cannot represent the packed-depth codec without banding/collapse.
precision highp float;

in highp float v_depth01;

// Packed-RGBA8 depth codec — VERBATIM from native shaders/shadow_depth.fragment.glsl:5-13
// (spec §3.2). The pack (here) and the receiver's unpack dot product are exact inverses
// (16581375 == 255^3); any drift on either side silently biases every depth comparison. Do not
// paraphrase or "clean up".
vec4 packDepth(float depth) {
    const float maxPackable = 1.0 - 1.0 / 16581375.0;
    depth = clamp(depth, 0.0, maxPackable);
    const vec4 bitSh = vec4(1.0, 255.0, 65025.0, 16581375.0);
    const vec4 mask  = vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
    vec4 enc = fract(bitSh * depth);
    enc -= enc.yzww * mask;
    return enc;
}

void main() {
    // Pack the [0,1] light-space depth — the exact metric the receiver compares against (§3.2).
    fragColor = packDepth(v_depth01);
}

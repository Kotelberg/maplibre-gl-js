// Shadow caster vertex shader. Renders visible fill-extrusion geometry from the sun's point of
// view; the fragment shader packs the resulting light-space depth into an RGBA8 offscreen map.
//
// Transcribed from native shaders/shadow_depth.vertex.glsl @ upstream-pr/fill-extrusion-shadows
// (657952f4), adapted to gl-js's `#pragma mapbox` data-driven plumbing: the base/height come from
// the same fill-extrusion paint-property binders the visible FE layer uses, so the caster
// interpolates to the identical building height at the same fractional zoom (spec §3.11). The
// per-tile light-clip matrix (u_light_matrix) is supplied per draw; the light frustum itself is
// computed in a later task (accepted here as a uniform).

uniform highp mat4 u_light_matrix;

in vec2 a_pos;
in vec4 a_normal_ed;

// The [0,1] light-space depth metric the receiver compares against. Deliberately kept SEPARATE
// from gl_Position.z (which is remapped to GL's [-1,1] NDC below so the offscreen hardware depth
// test runs at full precision) — spec §3.4. highp per §3.8.
out highp float v_depth01;

#pragma mapbox: define highp float base
#pragma mapbox: define highp float height

void main() {
    #pragma mapbox: initialize highp float base
    #pragma mapbox: initialize highp float height

    // Match the visible FE vertex EXACTLY: clamp, then select height vs base by the top/bottom flag
    // (the same `t = mod(normal.x, 2.0)` the FE vertex uses).
    base = max(0.0, base);
    height = max(0.0, height);

    highp float t = mod(a_normal_ed.x, 2.0);
    highp vec4 clip = u_light_matrix * vec4(a_pos, t > 0.0 ? height : base, 1.0);

    // Pack the [0,1] light-space depth (the exact metric the receiver compares against, §3.2/§3.4).
    v_depth01 = clip.z / clip.w;

    // Remap z from the matrix's [0,1] convention to GL's [-1,1] NDC so the offscreen depth test uses
    // the FULL depth buffer. WebGL2 shares GL's [-1,1] NDC, so this remap is required — without it
    // the caster occupies only the upper half of the range -> halved precision -> roof self-shadow
    // acne. Spec §3.4. Do NOT collapse v_depth01 into gl_Position.z — two deliberately different
    // values.
    clip.z = 2.0 * clip.z - clip.w;
    gl_Position = clip;
}

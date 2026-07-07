// Ground shadow-receiver vertex shader (spec §3.1). Draws a per-tile ground quad at z=0; the
// fragment shader samples the packed-depth cascade map(s) and writes a premultiplied-alpha shadow
// overlay. Transcribed from native shaders/ground_shadow.vertex.glsl @ 657952f4, with native's plain
// `u_matrix` (tile-local -> clip) replaced by gl-js's projection-prelude `u_projection_matrix` (the
// mercator per-tile clip transform; shadows are a mercator/anchor:"map" feature). highp throughout
// (§3.8). The per-tile per-cascade light-clip matrices (u_light_matrix, near->far) are supplied per
// draw; only the first u_cascade_count are valid.

in vec2 a_pos;

uniform highp mat4 u_light_matrix[4];
uniform highp int u_cascade_count;

out highp vec4 v_shadow_pos[4];
out highp float v_view_w;
flat out int v_cascade_count;

void main() {
    highp vec4 worldLocal = vec4(a_pos, 0.0, 1.0);
    highp vec4 clip = u_projection_matrix * worldLocal;
    gl_Position = clip;
    v_view_w = clip.w; // perspective view-distance for the near->far depth fade
    v_cascade_count = u_cascade_count;
    v_shadow_pos[0] = u_light_matrix[0] * worldLocal;
    v_shadow_pos[1] = u_light_matrix[u_cascade_count > 1 ? 1 : 0] * worldLocal;
    v_shadow_pos[2] = u_light_matrix[u_cascade_count > 2 ? 2 : 0] * worldLocal;
    v_shadow_pos[3] = u_light_matrix[u_cascade_count > 3 ? 3 : 0] * worldLocal;
}

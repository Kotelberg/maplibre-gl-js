// Fork-internal (HataHub): the model selection-bloom composite vertex shader.
// A fullscreen quad — the painter's `viewportBuffer` is (0,0),(1,0),(0,1),(1,1),
// so `a_pos` doubles as the [0,1] mask UV and, mapped `*2-1`, the clip-space
// corner. No precision qualifier on the attribute: gl-js's shader preprocessor
// parses attribute names with `in <type> <name>` and a qualifier would shift the
// capture (documented landmine — see model.vertex.glsl).
in vec2 a_pos;

out vec2 v_uv;

void main() {
    v_uv = a_pos;
    gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}

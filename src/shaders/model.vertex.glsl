// No precision qualifier on attributes: gl-js's shader preprocessor parses
// attribute names with `in <type> <name>` and a qualifier would shift the
// capture. Vertex-shader inputs default to highp in GLSL ES 3.0 regardless.
in vec3 a_pos;
in vec2 a_texcoord;

// World -> clip matrix for this instance group: baked ground-meters (relative
// to the group anchor) are pre-scaled to world pixels (x/y) and grown on the
// zoom ramp (z) on the CPU each frame, so the vertex shader is a plain
// transform. highp is required -- city-scale matrices band at the GLSL ES 3.00
// mediump default.
uniform highp mat4 u_matrix;

out highp vec2 v_texcoord;

void main() {
    v_texcoord = a_texcoord;
    gl_Position = u_matrix * vec4(a_pos, 1.0);
}

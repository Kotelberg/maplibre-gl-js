// Per-draw premultiplied color: for flat parts it is the baked-lambert part
// color scaled by the grow/fade ramp; for textured parts it is
// (white * fade, alpha = model-opacity * fade), modulating the sampled texture.
uniform highp vec4 u_color;
// 1.0 when this part carries a baseColor texture, 0.0 for flat-colored parts.
uniform highp float u_textured;
uniform sampler2D u_texture;

in highp vec2 v_texcoord;

void main() {
    highp vec4 color = u_color;

    if (u_textured > 0.5) {
        // Textures are uploaded premultiplied; u_color is the premultiplied
        // per-draw grow/fade/opacity factor, so the product stays premultiplied.
        color = texture(u_texture, v_texcoord) * u_color;
    }

    fragColor = color;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}

uniform vec3 u_lightcolor;
uniform lowp vec3 u_lightpos;
uniform lowp vec3 u_lightpos_globe;
uniform lowp float u_lightintensity;
uniform float u_vertical_gradient;
uniform lowp float u_opacity;
uniform vec2 u_fill_translate;

in vec2 a_pos;
in vec4 a_normal_ed;

#ifdef TERRAIN3D
    in vec2 a_centroid;
#endif


out vec4 v_color;

#ifdef RENDER_SHADOWS
// Shadow-receiver variant (spec §3, transcribed from native
// shaders/fill_extrusion_shadow.vertex.glsl @ 657952f4). The concentric per-cascade light-clip
// matrices are supplied per draw (near->far; only the first u_cascade_count are valid); each is the
// per-tile `tile-local -> light-clip` transform (worldToLightClip * tileMatrix), the same tile-local
// space the caster wrote depth in. highp throughout (§3.8).
uniform highp mat4 u_light_matrix[4];
uniform highp int u_cascade_count;

out highp vec4 v_shadow_pos[4];
out highp float v_slope;
out highp float v_wallness;
flat out int v_cascade_count;
#endif

#pragma mapbox: define highp float base
#pragma mapbox: define highp float height

#pragma mapbox: define highp vec4 color

void main() {
    #pragma mapbox: initialize highp float base
    #pragma mapbox: initialize highp float height
    #pragma mapbox: initialize highp vec4 color

    vec3 normal = a_normal_ed.xyz;

    #ifdef TERRAIN3D
	    // Raise the "ceiling" of elements by the elevation of the centroid, in meters.
        float height_terrain3d_offset = get_elevation(a_centroid);
        // To avoid having buildings "hang above a slope", create a "basement"
        // by lowering the "floor" of ground-level (and below) elements.
        // This is in addition to the elevation of the centroid, in meters.
        float base_terrain3d_offset = height_terrain3d_offset - (base > 0.0 ? 0.0 : 10.0);
    #else
        float height_terrain3d_offset = 0.0;
        float base_terrain3d_offset = 0.0;
    #endif
    // Sub-terranian "floors and ceilings" are clamped to ground-level.
    // 3D Terrain offsets, if applicable, are applied on the result.
    base = max(0.0, base) + base_terrain3d_offset;
    height = max(0.0, height) + height_terrain3d_offset;

    float t = mod(normal.x, 2.0);
    float elevation = t > 0.0 ? height : base;
    vec2 posInTile = a_pos + u_fill_translate;

    #ifdef GLOBE
        vec3 spherePos = projectToSphere(posInTile, a_pos);
        gl_Position = interpolateProjectionFor3D(posInTile, spherePos, elevation);
    #else
        gl_Position = u_projection_matrix * vec4(posInTile, elevation, 1.0);
    #endif

    // Relative luminance (how dark/bright is the surface color?)
    float colorvalue = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;

    v_color = vec4(0.0, 0.0, 0.0, 1.0);

    // Add slight ambient lighting so no extrusions are totally black
    vec4 ambientlight = vec4(0.03, 0.03, 0.03, 1.0);
    color += ambientlight;

    // Calculate cos(theta), where theta is the angle between surface normal and diffuse light ray
    vec3 normalForLighting = normal / 16384.0;
    float directional = clamp(dot(normalForLighting, u_lightpos), 0.0, 1.0);

#ifdef RENDER_SHADOWS
    // v_slope = (1 - n·L): 0 on sun-facing faces, ->1 on faces turned away. Captured HERE, from the
    // raw clamped directional fraction, BEFORE the directional term is remapped for face shading
    // below (native fill_extrusion_shadow.vertex.glsl:93 computes it from the same raw fraction).
    // It scales the receiver's depth bias so a building never self-shadows its own away-faces (§3.6).
    // Shadows are a mercator (anchor:"map") feature, so the pre-GLOBE-mix fraction is the right one.
    v_slope = 1.0 - directional;
#endif

    #ifdef GLOBE
        mat3 rotMatrix = globeGetRotationMatrix(spherePos);
        normalForLighting = rotMatrix * normalForLighting;
        // Interpolate dot product result instead of normals and light direction
        directional = mix(directional, clamp(dot(normalForLighting, u_lightpos_globe), 0.0, 1.0), u_projection_transition);
    #endif

    // Adjust directional so that
    // the range of values for highlight/shading is narrower
    // with lower light intensity
    // and with lighter/brighter surface colors
    directional = mix((1.0 - u_lightintensity), max((1.0 - colorvalue + u_lightintensity), 1.0), directional);

    // Add gradient along z axis of side surfaces
    if (normal.y != 0.0) {
        // This avoids another branching statement, but multiplies by a constant of 0.84 if no vertical gradient,
        // and otherwise calculates the gradient based on base + height
        directional *= (
            (1.0 - u_vertical_gradient) +
            (u_vertical_gradient * clamp((t + base) * pow(height / 150.0, 0.5), mix(0.7, 0.98, 1.0 - u_lightintensity), 1.0)));
    }

    // Assign final color based on surface + ambient light color, diffuse light directional, and light color
    // with lower bounds adjusted to hue of light
    // so that shading is tinted with the complementary (opposite) color to the light color
    v_color.r += clamp(color.r * directional * u_lightcolor.r, mix(0.0, 0.3, 1.0 - u_lightcolor.r), 1.0);
    v_color.g += clamp(color.g * directional * u_lightcolor.g, mix(0.0, 0.3, 1.0 - u_lightcolor.g), 1.0);
    v_color.b += clamp(color.b * directional * u_lightcolor.b, mix(0.0, 0.3, 1.0 - u_lightcolor.b), 1.0);
    v_color *= u_opacity;

#ifdef RENDER_SHADOWS
    // 1.0 on vertical walls (normal.z~0), 0.0 on roofs (normal.z~+-1). Used by the fragment shader to
    // suppress the projective-aliased cast-shadow term on walls (§3.7); note the metric is
    // 1 - |normal.z|, NOT the stock normal.y heuristic (native fill_extrusion_shadow.vertex.glsl:95).
    v_wallness = 1.0 - abs(normalForLighting.z);
    v_cascade_count = u_cascade_count;

    // Project into every cascade's light clip (near->far). Sampled in tile-local space using the same
    // `vec4(a_pos, elevation, 1.0)` the caster wrote depth with (un-translated a_pos, matching the
    // shadowDepth caster) so the receiver samples exactly where the occluder was recorded. Unused
    // cascade slots replicate cascade 0 (native fill_extrusion_shadow.vertex.glsl:98-101).
    highp vec4 shadowWorldLocal = vec4(a_pos, elevation, 1.0);
    v_shadow_pos[0] = u_light_matrix[0] * shadowWorldLocal;
    v_shadow_pos[1] = u_light_matrix[u_cascade_count > 1 ? 1 : 0] * shadowWorldLocal;
    v_shadow_pos[2] = u_light_matrix[u_cascade_count > 2 ? 2 : 0] * shadowWorldLocal;
    v_shadow_pos[3] = u_light_matrix[u_cascade_count > 3 ? 3 : 0] * shadowWorldLocal;
#endif
}

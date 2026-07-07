import {
    Uniform1i,
    Uniform1f,
    Uniform4f,
    UniformMatrix4fv
} from '../uniform_binding';

import type {Context} from '../../gl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';

/**
 * @internal
 * Uniforms for the `groundShadow` receiver program (spec §3.1). The ground quad is projected by the
 * projection prelude's `u_projection_matrix` (bound separately by {@link Program}), so this binder
 * carries only the per-cascade light matrices + the shadow sampler / bias / fade controls the ground
 * fragment shader reads.
 */
export type GroundShadowUniformsType = {
    'u_light_matrix': UniformMatrix4fv;
    'u_cascade_count': Uniform1i;
    'u_shadowmap0': Uniform1i;
    'u_shadowmap1': Uniform1i;
    'u_shadowmap2': Uniform1i;
    'u_shadowmap3': Uniform1i;
    'u_shadow_color': Uniform4f;
    'u_shadow_intensity': Uniform1f;
    'u_shadow_texel_size': Uniform1f;
    // Ground bias is constant-only — no slope / per-cascade scale (§3.6).
    'u_shadow_bias': Uniform1f;
    // Frustum-edge (UV-radial) fade against the far cascade + the near->far view-distance fade.
    'u_shadow_fade_start': Uniform1f;
    'u_depth_fade_start': Uniform1f;
    'u_depth_fade_end': Uniform1f;
};

/**
 * The per-frame inputs Task 5 threads into the ground receiver draw. Semantics mirror
 * `FillExtrusionShadowParams`: `lightMatrices` is a flattened `Float32Array` of `16 * cascadeCount`
 * per-tile `tile-local → light-clip` matrices; `intensity` is the evaluated `shadow-intensity`
 * ALREADY gated by `shadowHeightFade(zoom)` and `shadowMapUsable` (§3.11 / §3.3.3). `shadowColor` is
 * premultiplication-safe when black (the default). The `*Fade*` scalars come from the frustum fit
 * (Task 4); pass `0` to disable a fade (the shader early-outs to no fade).
 */
export type GroundShadowParams = {
    lightMatrices: Float32Array;
    cascadeCount: number;
    shadowColor: [number, number, number, number];
    intensity: number;
    texelSize: number;
    bias: number;
    fadeStart: number;
    depthFadeStart: number;
    depthFadeEnd: number;
    shadowmapUnits: [number, number, number, number];
};

const groundShadowUniforms = (context: Context, locations: UniformLocations): GroundShadowUniformsType => ({
    'u_light_matrix': new UniformMatrix4fv(context, locations.u_light_matrix),
    'u_cascade_count': new Uniform1i(context, locations.u_cascade_count),
    'u_shadowmap0': new Uniform1i(context, locations.u_shadowmap0),
    'u_shadowmap1': new Uniform1i(context, locations.u_shadowmap1),
    'u_shadowmap2': new Uniform1i(context, locations.u_shadowmap2),
    'u_shadowmap3': new Uniform1i(context, locations.u_shadowmap3),
    'u_shadow_color': new Uniform4f(context, locations.u_shadow_color),
    'u_shadow_intensity': new Uniform1f(context, locations.u_shadow_intensity),
    'u_shadow_texel_size': new Uniform1f(context, locations.u_shadow_texel_size),
    'u_shadow_bias': new Uniform1f(context, locations.u_shadow_bias),
    'u_shadow_fade_start': new Uniform1f(context, locations.u_shadow_fade_start),
    'u_depth_fade_start': new Uniform1f(context, locations.u_depth_fade_start),
    'u_depth_fade_end': new Uniform1f(context, locations.u_depth_fade_end),
});

const groundShadowUniformValues = (shadow: GroundShadowParams): UniformValues<GroundShadowUniformsType> => ({
    'u_light_matrix': shadow.lightMatrices,
    'u_cascade_count': shadow.cascadeCount,
    'u_shadowmap0': shadow.shadowmapUnits[0],
    'u_shadowmap1': shadow.shadowmapUnits[1],
    'u_shadowmap2': shadow.shadowmapUnits[2],
    'u_shadowmap3': shadow.shadowmapUnits[3],
    'u_shadow_color': shadow.shadowColor,
    'u_shadow_intensity': shadow.intensity,
    'u_shadow_texel_size': shadow.texelSize,
    'u_shadow_bias': shadow.bias,
    'u_shadow_fade_start': shadow.fadeStart,
    'u_depth_fade_start': shadow.depthFadeStart,
    'u_depth_fade_end': shadow.depthFadeEnd,
});

export {groundShadowUniforms, groundShadowUniformValues};

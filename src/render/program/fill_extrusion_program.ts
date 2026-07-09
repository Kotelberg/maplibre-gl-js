import {patternUniformValues} from './pattern';
import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    Uniform3f,
    UniformMatrix4fv
} from '../uniform_binding';

import {mat3, vec3} from 'gl-matrix';
import {extend} from '../../util/util';

import type {Context} from '../../gl/context';
import type {Painter} from '../painter';
import type {OverscaledTileID} from '../../tile/tile_id';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {CrossfadeParameters} from '../../style/evaluation_parameters';
import type {Tile} from '../../tile/tile';

export type FillExtrusionUniformsType = {
    'u_lightpos': Uniform3f;
    'u_lightpos_globe': Uniform3f;
    'u_lightintensity': Uniform1f;
    'u_lightcolor': Uniform3f;
    'u_vertical_gradient': Uniform1f;
    'u_opacity': Uniform1f;
    'u_fill_translate': Uniform2f;
};

export type FillExtrusionPatternUniformsType = {
    'u_lightpos': Uniform3f;
    'u_lightpos_globe': Uniform3f;
    'u_lightintensity': Uniform1f;
    'u_lightcolor': Uniform3f;
    'u_height_factor': Uniform1f;
    'u_vertical_gradient': Uniform1f;
    'u_opacity': Uniform1f;
    'u_fill_translate': Uniform2f;
    // pattern uniforms:
    'u_texsize': Uniform2f;
    'u_image': Uniform1i;
    'u_pixel_coord_upper': Uniform2f;
    'u_pixel_coord_lower': Uniform2f;
    'u_scale': Uniform3f;
    'u_fade': Uniform1f;
};

const fillExtrusionUniforms = (context: Context, locations: UniformLocations): FillExtrusionUniformsType => ({
    'u_lightpos': new Uniform3f(context, locations.u_lightpos),
    'u_lightpos_globe': new Uniform3f(context, locations.u_lightpos_globe),
    'u_lightintensity': new Uniform1f(context, locations.u_lightintensity),
    'u_lightcolor': new Uniform3f(context, locations.u_lightcolor),
    'u_vertical_gradient': new Uniform1f(context, locations.u_vertical_gradient),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate),
});

const fillExtrusionPatternUniforms = (context: Context, locations: UniformLocations): FillExtrusionPatternUniformsType => ({
    'u_lightpos': new Uniform3f(context, locations.u_lightpos),
    'u_lightpos_globe': new Uniform3f(context, locations.u_lightpos_globe),
    'u_lightintensity': new Uniform1f(context, locations.u_lightintensity),
    'u_lightcolor': new Uniform3f(context, locations.u_lightcolor),
    'u_vertical_gradient': new Uniform1f(context, locations.u_vertical_gradient),
    'u_height_factor': new Uniform1f(context, locations.u_height_factor),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate),
    // pattern uniforms
    'u_image': new Uniform1i(context, locations.u_image),
    'u_texsize': new Uniform2f(context, locations.u_texsize),
    'u_pixel_coord_upper': new Uniform2f(context, locations.u_pixel_coord_upper),
    'u_pixel_coord_lower': new Uniform2f(context, locations.u_pixel_coord_lower),
    'u_scale': new Uniform3f(context, locations.u_scale),
    'u_fade': new Uniform1f(context, locations.u_fade)
});

const fillExtrusionUniformValues = (
    painter: Painter,
    shouldUseVerticalGradient: boolean,
    opacity: number,
    translate: [number, number],
): UniformValues<FillExtrusionUniformsType> => {
    const light = painter.style.light;
    const _lp = light.properties.get('position');
    const lightPos = [_lp.x, _lp.y, _lp.z] as vec3;
    const lightMat = mat3.create();
    if (light.properties.get('anchor') === 'viewport') {
        mat3.fromRotation(lightMat, painter.transform.bearingInRadians);
    }
    vec3.transformMat3(lightPos, lightPos, lightMat);
    const transformedLightPos = painter.transform.transformLightDirection(lightPos);

    const lightColor = light.properties.get('color');

    return {
        'u_lightpos': lightPos,
        'u_lightpos_globe': transformedLightPos,
        'u_lightintensity': light.properties.get('intensity'),
        'u_lightcolor': [lightColor.r, lightColor.g, lightColor.b],
        'u_vertical_gradient': +shouldUseVerticalGradient,
        'u_opacity': opacity,
        'u_fill_translate': translate,
    };
};

const fillExtrusionPatternUniformValues = (
    painter: Painter,
    shouldUseVerticalGradient: boolean,
    opacity: number,
    translate: [number, number],
    coord: OverscaledTileID,
    crossfade: CrossfadeParameters,
    tile: Tile
): UniformValues<FillExtrusionPatternUniformsType> => {
    return extend(fillExtrusionUniformValues(painter, shouldUseVerticalGradient, opacity, translate),
        patternUniformValues(crossfade, painter, tile),
        {
            'u_height_factor': -Math.pow(2, coord.overscaledZ) / tile.tileSize / 8
        });
};

// ---------------------------------------------------------------------------------------------
// Shadow-receiver variant (spec §3). The `fillExtrusionShadow` program shares the fill-extrusion
// .glsl source (compiled with `#define RENDER_SHADOWS`) but binds an EXTENDED uniform set: the base
// FE lighting uniforms PLUS the per-cascade light matrices + the shadow sampler / bias / intensity
// controls the receiver fragment shader reads. Task 5 (painter integration) supplies the per-frame
// values via {@link fillExtrusionShadowUniformValues}.
// ---------------------------------------------------------------------------------------------

export type FillExtrusionShadowUniformsType = FillExtrusionUniformsType & {
    // Vertex: per-cascade `tile-local -> light-clip` matrices (near->far; flattened mat4[4]) + count.
    'u_light_matrix': UniformMatrix4fv;
    'u_cascade_count': Uniform1i;
    // Fragment: the four packed-depth cascade samplers (static-sampler if-chain, §3.9).
    'u_shadowmap0': Uniform1i;
    'u_shadowmap1': Uniform1i;
    'u_shadowmap2': Uniform1i;
    'u_shadowmap3': Uniform1i;
    // Fragment: strength + PCF texel size + the §3.6 bias pair.
    'u_shadow_intensity': Uniform1f;
    'u_shadow_texel_size': Uniform1f;
    'u_shadow_bias': Uniform1f;
    'u_shadow_slope_bias': Uniform1f;
};

/**
 * The per-frame shadow inputs Task 5 threads into the building receiver draw.
 * `lightMatrices` is a flattened `Float32Array` of `16 * cascadeCount` (up to 4) cascade matrices,
 * each the per-tile `tile-local → light-clip` transform. `intensity` is the evaluated
 * `shadow-intensity` ALREADY multiplied by `shadowHeightFade(zoom)` and the `shadowMapUsable` gate
 * (§3.11 / §3.3.3) — the receiver applies it verbatim. `bias`/`slopeBias` are the shipped `0.0`/`0.05`
 * (§3.6). `shadowmapUnits` are the texture units the four cascade maps are bound to (default 0..3).
 */
export type FillExtrusionShadowParams = {
    lightMatrices: Float32Array;
    cascadeCount: number;
    intensity: number;
    texelSize: number;
    bias: number;
    slopeBias: number;
    shadowmapUnits: [number, number, number, number];
};

const fillExtrusionShadowUniforms = (context: Context, locations: UniformLocations): FillExtrusionShadowUniformsType => ({
    ...fillExtrusionUniforms(context, locations),
    'u_light_matrix': new UniformMatrix4fv(context, locations.u_light_matrix),
    'u_cascade_count': new Uniform1i(context, locations.u_cascade_count),
    'u_shadowmap0': new Uniform1i(context, locations.u_shadowmap0),
    'u_shadowmap1': new Uniform1i(context, locations.u_shadowmap1),
    'u_shadowmap2': new Uniform1i(context, locations.u_shadowmap2),
    'u_shadowmap3': new Uniform1i(context, locations.u_shadowmap3),
    'u_shadow_intensity': new Uniform1f(context, locations.u_shadow_intensity),
    'u_shadow_texel_size': new Uniform1f(context, locations.u_shadow_texel_size),
    'u_shadow_bias': new Uniform1f(context, locations.u_shadow_bias),
    'u_shadow_slope_bias': new Uniform1f(context, locations.u_shadow_slope_bias),
});

const fillExtrusionShadowUniformValues = (
    painter: Painter,
    shouldUseVerticalGradient: boolean,
    opacity: number,
    translate: [number, number],
    shadow: FillExtrusionShadowParams,
): UniformValues<FillExtrusionShadowUniformsType> => {
    return extend(
        fillExtrusionUniformValues(painter, shouldUseVerticalGradient, opacity, translate),
        {
            'u_light_matrix': shadow.lightMatrices,
            'u_cascade_count': shadow.cascadeCount,
            'u_shadowmap0': shadow.shadowmapUnits[0],
            'u_shadowmap1': shadow.shadowmapUnits[1],
            'u_shadowmap2': shadow.shadowmapUnits[2],
            'u_shadowmap3': shadow.shadowmapUnits[3],
            'u_shadow_intensity': shadow.intensity,
            'u_shadow_texel_size': shadow.texelSize,
            'u_shadow_bias': shadow.bias,
            'u_shadow_slope_bias': shadow.slopeBias,
        });
};

export {
    fillExtrusionUniforms,
    fillExtrusionPatternUniforms,
    fillExtrusionUniformValues,
    fillExtrusionPatternUniformValues,
    fillExtrusionShadowUniforms,
    fillExtrusionShadowUniformValues
};

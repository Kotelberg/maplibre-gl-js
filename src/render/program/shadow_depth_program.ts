import {UniformMatrix4f} from '../uniform_binding';

import type {mat4} from 'gl-matrix';
import type {Context} from '../../gl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';

/**
 * @internal
 * Uniforms for the `shadowDepth` (caster) program. The per-tile light-clip matrix is the only
 * fixed uniform; base/height ride the reused fill-extrusion paint-property binders (spec §3.11).
 */
export type ShadowDepthUniformsType = {
    'u_light_matrix': UniformMatrix4f;
};

const shadowDepthUniforms = (context: Context, locations: UniformLocations): ShadowDepthUniformsType => ({
    'u_light_matrix': new UniformMatrix4f(context, locations.u_light_matrix),
});

const shadowDepthUniformValues = (lightMatrix: mat4): UniformValues<ShadowDepthUniformsType> => ({
    'u_light_matrix': lightMatrix,
});

export {shadowDepthUniforms, shadowDepthUniformValues};

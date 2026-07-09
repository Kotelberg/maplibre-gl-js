// Fork-internal (HataHub): uniform binder for the model selection-bloom composite
// program. Not upstreamed — lives on the integration branch only.
import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    Uniform4f
} from '../uniform_binding';

import type {Context} from '../../gl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {vec2, vec4} from 'gl-matrix';

export type ModelBloomUniformsType = {
    'u_image': Uniform1i;
    'u_color': Uniform4f;
    'u_texel': Uniform2f;
    'u_radius': Uniform1f;
};

const modelBloomUniforms = (context: Context, locations: UniformLocations): ModelBloomUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    // u_color is passed raw [r, g, b, intensity] (Uniform4f, not UniformColor):
    // the shader premultiplies by the halo alpha itself, so no premult here.
    'u_color': new Uniform4f(context, locations.u_color),
    'u_texel': new Uniform2f(context, locations.u_texel),
    'u_radius': new Uniform1f(context, locations.u_radius)
});

const modelBloomUniformValues = (
    imageUnit: number,
    color: vec4,
    texel: vec2,
    radius: number
): UniformValues<ModelBloomUniformsType> => ({
    'u_image': imageUnit,
    'u_color': color,
    'u_texel': texel,
    'u_radius': radius
});

export {modelBloomUniforms, modelBloomUniformValues};

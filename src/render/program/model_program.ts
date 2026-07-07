import {
    Uniform1i,
    Uniform1f,
    UniformMatrix4f,
    UniformColor
} from '../uniform_binding';

import type {Context} from '../../gl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {mat4} from 'gl-matrix';

export type ModelUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_color': UniformColor;
    'u_textured': Uniform1f;
    'u_texture': Uniform1i;
};

const modelUniforms = (context: Context, locations: UniformLocations): ModelUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_color': new UniformColor(context, locations.u_color),
    'u_textured': new Uniform1f(context, locations.u_textured),
    'u_texture': new Uniform1i(context, locations.u_texture)
});

const modelUniformValues = (
    matrix: mat4,
    color: Color,
    textured: boolean
): UniformValues<ModelUniformsType> => ({
    'u_matrix': matrix,
    'u_color': color,
    'u_textured': textured ? 1 : 0,
    'u_texture': 0
});

export {modelUniforms, modelUniformValues};

import {createLayout} from '../../util/struct_array';

/**
 * Vertex layout for baked `model`-layer geometry: a float position in ground
 * meters (relative to the group anchor, z up) plus the part's texcoord. The
 * generator emits `ModelLayoutArray` (a `StructArrayLayout3f2f20`) from this;
 * `render/model/model_placement.ts` fills it and `render/draw_model.ts` uploads
 * it. Floats (not the Int16 that tile-local layers use) because model positions
 * are world-space meters, not `[0, EXTENT]` tile units.
 */
export const modelAttributes = createLayout([
    {name: 'a_pos', type: 'Float32', components: 3},
    {name: 'a_texcoord', type: 'Float32', components: 2}
], 4);

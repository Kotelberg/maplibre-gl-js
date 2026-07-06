import {StyleLayer} from '../style_layer';
import {NoopModelBucket} from '../../data/bucket/noop_model_bucket';

import properties, {type ModelLayoutPropsPossiblyEvaluated, type ModelPaintPropsPossiblyEvaluated} from './model_style_layer_properties.g';
import {type Transitionable, type Transitioning, type Layout, type PossiblyEvaluated} from '../properties';

import type {ModelLayoutProps, ModelPaintProps} from './model_style_layer_properties.g';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {BucketParameters} from '../../data/bucket';

export const isModelStyleLayer = (layer: StyleLayer): layer is ModelStyleLayer => layer.type === 'model';

/**
 * Experimental `model` layer: places a 3D glTF/GLB model at each Point of a
 * GeoJSON source. The model to draw is selected per-feature by `model-id` and
 * resolved through a host-supplied runtime asset registry (the `addModel` API),
 * which is intentionally never part of the serialized style.
 *
 * Placement, geometry baking, and drawing live on the main thread in
 * `render/model/model_placement.ts` + `render/draw_model.ts`; the per-feature
 * `model-id` resolves through the host-supplied `map.addModel` registry.
 */
export class ModelStyleLayer extends StyleLayer {
    _unevaluatedLayout: Layout<ModelLayoutProps>;
    layout: PossiblyEvaluated<ModelLayoutProps, ModelLayoutPropsPossiblyEvaluated>;

    _transitionablePaint: Transitionable<ModelPaintProps>;
    _transitioningPaint: Transitioning<ModelPaintProps>;
    paint: PossiblyEvaluated<ModelPaintProps, ModelPaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
    }

    createBucket(parameters: BucketParameters<any>) {
        // Model instances are placed world-anchored on the main thread, not from
        // tile-local worker buckets. This noop keeps `worker_tile`'s
        // unconditional `createBucket` call valid; it reports empty and is
        // dropped before serialization. See `NoopModelBucket`.
        return new NoopModelBucket(parameters.layers);
    }

    is3D(): boolean {
        // Baked meshes have per-pixel depth and share the 3D/translucent depth
        // range; drawn in the translucent pass with depth read+write.
        return true;
    }
}

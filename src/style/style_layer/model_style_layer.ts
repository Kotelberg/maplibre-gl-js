import {StyleLayer} from '../style_layer';

import properties, {type ModelLayoutPropsPossiblyEvaluated, type ModelPaintPropsPossiblyEvaluated} from './model_style_layer_properties.g';
import {type Transitionable, type Transitioning, type Layout, type PossiblyEvaluated} from '../properties';

import type {ModelLayoutProps, ModelPaintProps} from './model_style_layer_properties.g';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

export const isModelStyleLayer = (layer: StyleLayer): layer is ModelStyleLayer => layer.type === 'model';

/**
 * Experimental `model` layer: places a 3D glTF/GLB model at each Point of a
 * GeoJSON source. The model to draw is selected per-feature by `model-id` and
 * resolved through a host-supplied runtime asset registry (the `addModel` API),
 * which is intentionally never part of the serialized style.
 *
 * This is the layer scaffolding only: it round-trips through validation and
 * serialization and evaluates its properties, but has no bucket and no render
 * path yet (the painter's dispatch renders nothing for an unhandled type). The
 * model program, placement, and asset registry are added in a later task.
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
}

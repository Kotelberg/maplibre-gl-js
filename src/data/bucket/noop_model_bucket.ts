import type {
    Bucket,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import type {ModelStyleLayer} from '../../style/style_layer/model_style_layer';
import type {Context} from '../../gl/context';
import type {CanonicalTileID} from '../../tile/tile_id';

/**
 * The `model` layer does not build tile-local geometry on the worker. Model
 * instances are world-anchored and placed on the main thread by reading the
 * layer's GeoJSON source across the viewport tile cover (see
 * `render/model/model_placement.ts`), because a per-tile bucket cannot express
 * a mesh baked in world space relative to a group anchor that spans the cover.
 *
 * gl-js nonetheless calls `layer.createBucket(...)` unconditionally for every
 * layer bound to a source (`source/worker_tile.ts`), so a `model` layer on a
 * GeoJSON source must return *a* valid `Bucket` or tiling throws. This is the
 * gl-js analogue of native's `NoopModelBucket` (`hasData() == false`): it
 * reports `isEmpty()` so `worker_tile` drops it before serialization — it never
 * crosses the worker boundary and produces no draw geometry.
 */
export class NoopModelBucket implements Bucket {
    layerIds: Array<string>;
    layers: Array<ModelStyleLayer>;
    stateDependentLayers: Array<ModelStyleLayer>;
    stateDependentLayerIds: Array<string>;
    hasDependencies: boolean;

    constructor(layers: Array<ModelStyleLayer>) {
        this.layers = layers;
        this.layerIds = layers.map((layer) => layer.id);
        this.stateDependentLayers = [];
        this.stateDependentLayerIds = [];
        this.hasDependencies = false;
    }

    populate(_features: Array<IndexedFeature>, _options: PopulateParameters, _canonical: CanonicalTileID) {}

    update() {}

    isEmpty(): boolean {
        // Always empty: `worker_tile` filters empty buckets out before
        // serialization, so this bucket is never transferred or rendered.
        return true;
    }

    uploadPending(): boolean {
        return false;
    }

    upload(_context: Context) {}

    destroy() {}
}

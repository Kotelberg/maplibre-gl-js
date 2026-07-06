import {EXTENT} from '../../data/extent';
import {GEOJSON_TILE_LAYER_NAME} from '../../data/feature_index';

import type {OverscaledTileID} from '../../tile/tile_id';
import type {TileManager} from '../../tile/tile_manager';
import type {ModelStyleLayer} from '../../style/style_layer/model_style_layer';

/**
 * One placed model instance, resolved from a GeoJSON Point feature. Position is
 * a zoom-free mercator world fraction ([0,1] nw→se); the per-instance
 * transform (`model-scale`/`-rotation`/`-footprint`) is evaluated once here.
 */
export type PlacedInstance = {
    fx: number;
    fy: number;
    modelId: string | undefined;
    scale: number;
    rotation: number;
    footprint: number;
    /**
     * The source feature's id (fork-internal: drives the selection bloom). Carried
     * so `map.setModelSelection(featureId)` can pick out one instance's silhouette.
     * `undefined` for features without an id (they can never be selected).
     */
    featureId: string | number | undefined;
};

export type ModelPlacements = {
    /** FNV-1a signature of the viewport tile cover (decimal string of a uint64). */
    coverSig: string;
    /** Order-independent hash of the deduplicated instance anchors. */
    placementKey: string;
    instances: PlacedInstance[];
};

// FNV-1a (64-bit) constants, verbatim from native render_model_layer.cpp.
// Built via BigInt(...) rather than `n` literals (the ES2016 target forbids the
// literal suffix; BigInt values themselves are fine).
const FNV_OFFSET = BigInt('1469598103934665603');
const FNV_PRIME = BigInt('1099511628211');
const U64_MASK = BigInt('18446744073709551615'); // 0xffffffffffffffff
// Anchor-mixing multiplier (native's placement key), a 64-bit odd constant.
const ANCHOR_MIX = BigInt('11400714819323198485'); // 0x9e3779b97f4a7c15
const SHIFT_58 = BigInt(58);
const SHIFT_32 = BigInt(32);
const SHIFT_29 = BigInt(29);

/**
 * 64-bit FNV-1a signature of the viewport tile cover (each tile's canonical
 * z/x/y), verbatim from native. The cheap early-out key: an unchanged cover +
 * source cannot change the placements, so the whole synchronous feature walk is
 * skipped. Returned as a decimal string of a uint64.
 */
export function coverSignature(coords: Array<OverscaledTileID>): string {
    let coverSig = FNV_OFFSET;
    for (const coord of coords) {
        const {z, x, y} = coord.canonical;
        const mix = ((BigInt(z) << SHIFT_58) ^ (BigInt(x) << SHIFT_29) ^ BigInt(y)) & U64_MASK;
        coverSig = ((coverSig ^ mix) * FNV_PRIME) & U64_MASK;
    }
    return coverSig.toString();
}

/**
 * Read Point features from the layer's GeoJSON source across the viewport tile
 * cover and resolve each into a placed model instance. Ported from native
 * `RenderModelLayer::update` (`render_model_layer.cpp`): features that repeat in
 * adjacent tile buffers dedup on a quantized world-fraction anchor (32-bit per
 * axis), and `model-id`/`model-scale`/`model-rotation`/`model-footprint` are
 * evaluated per feature through the layer's data-driven property machinery.
 *
 * gl-js reads the source's already-tiled features (the main thread has no raw
 * GeoJSON), the idiomatic analogue of native's `getTile()` walk: the covering
 * tiles ARE the source's viewport cover, and their canonical ids map tile-EXTENT
 * coordinates back to zoom-free world fractions.
 */
export function readModelPlacements(
    coords: Array<OverscaledTileID>,
    tileManager: TileManager,
    layer: ModelStyleLayer,
    availableImages: Array<string>
): ModelPlacements {
    const coverSig = coverSignature(coords);

    const modelIdProp = layer.layout.get('model-id');
    const scaleProp = layer.paint.get('model-scale');
    const rotationProp = layer.paint.get('model-rotation');
    const footprintProp = layer.paint.get('model-footprint');

    const seen = new Set<string>();
    const instances: PlacedInstance[] = [];
    let placementKey = BigInt(0);

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const featureIndex = tile && tile.latestFeatureIndex;
        if (!featureIndex || !featureIndex.rawTileData) continue;

        const vtLayers = featureIndex.loadVTLayers();
        const sourceLayer = vtLayers[GEOJSON_TILE_LAYER_NAME];
        if (!sourceLayer) continue;

        const {z, x, y} = coord.canonical;
        const tiles = Math.pow(2, z);

        for (let i = 0; i < sourceLayer.length; i++) {
            const feature = sourceLayer.feature(i);
            // Point features only (native matches a single point geometry).
            if (feature.type !== 1) continue;

            const geometry = feature.loadGeometry();
            const evalFeature = {type: feature.type, properties: feature.properties, id: feature.id} as any;

            for (const ring of geometry) {
                for (const point of ring) {
                    // Tile EXTENT units → zoom-free mercator world fraction.
                    const fx = (x + point.x / EXTENT) / tiles;
                    const fy = (y + point.y / EXTENT) / tiles;

                    const qx = Math.round(fx * 4294967296) >>> 0;
                    const qy = Math.round(fy * 4294967296) >>> 0;
                    const anchorKey = `${qx},${qy}`;
                    if (seen.has(anchorKey)) continue;
                    seen.add(anchorKey);

                    placementKey ^= (((BigInt(qx) << SHIFT_32) | BigInt(qy)) * ANCHOR_MIX) & U64_MASK;

                    const modelId = modelIdProp.evaluate(evalFeature, {}, coord.canonical, availableImages);
                    instances.push({
                        fx,
                        fy,
                        modelId: modelId === undefined || modelId === '' ? undefined : String(modelId),
                        scale: scaleProp.evaluate(evalFeature, {}, coord.canonical, availableImages),
                        rotation: rotationProp.evaluate(evalFeature, {}, coord.canonical, availableImages),
                        footprint: footprintProp.evaluate(evalFeature, {}, coord.canonical, availableImages),
                        featureId: feature.id
                    });
                }
            }
        }
    }

    return {
        coverSig,
        placementKey: placementKey.toString(),
        instances
    };
}

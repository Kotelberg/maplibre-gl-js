import {beforeAll, describe, test, expect} from 'vitest';
import {FillExtrusionBucket, roundRingCorners, roundPolygonCorners} from './fill_extrusion_bucket';
import {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import {type LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type EvaluationParameters} from '../../style/evaluation_parameters';
import {type ZoomHistory} from '../../style/zoom_history';
import {type BucketParameters} from '../bucket';
import {type CreateBucketParameters, createPopulateOptions, getFeaturesFromLayer, loadVectorTile} from '../../../test/unit/lib/tile';
import {type VectorTileLayerLike} from '@maplibre/vt-pbf';
import {type CanonicalTileID} from '../../tile/tile_id';
import Point from '@mapbox/point-geometry';

function ring(...coords: Array<[number, number]>): Array<Point> {
    return coords.map(([x, y]) => new Point(x, y));
}

function toPairs(points: Array<Point>): Array<[number, number]> {
    return points.map(p => [p.x, p.y]);
}

function createFillExtrusionBucket({id, layout, paint, globalState, availableImages}: CreateBucketParameters): FillExtrusionBucket {
    const layer = new FillExtrusionStyleLayer({
        id,
        type: 'fill-extrusion',
        layout,
        paint
    } as LayerSpecification, globalState);
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters,
        availableImages as Array<string>);

    return new FillExtrusionBucket({layers: [layer]} as BucketParameters<FillExtrusionStyleLayer>);
}

describe('FillExtrusionBucket', () => {
    let sourceLayer: VectorTileLayerLike;
    beforeAll(() => {
        // Load fill extrusion features from fixture tile.
        sourceLayer = loadVectorTile().layers.water;
    });

    test('FillExtrusionBucket fill-pattern with global-state', () => {
        const availableImages = [];
        const bucket = createFillExtrusionBucket({id: 'test',
            paint: {'fill-extrusion-pattern': ['coalesce', ['get', 'pattern'], ['global-state', 'pattern']]},
            globalState: {pattern: 'test-pattern'},
            availableImages
        });

        bucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), undefined);

        expect(bucket.features.length).toBeGreaterThan(0);
        expect(bucket.features[0].patterns).toEqual({
            test: {min: 'test-pattern', mid: 'test-pattern', max: 'test-pattern'}
        });
    });

    test('default fill-extrusion-edge-radius is 0 and leaves side-face vertices unchanged', () => {
        const availableImages = [];
        const base = createFillExtrusionBucket({id: 'base', availableImages});
        base.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), {z: 15, x: 0, y: 0} as CanonicalTileID);

        const explicitZero = createFillExtrusionBucket({id: 'zero', layout: {'fill-extrusion-edge-radius': 0}, availableImages});
        explicitZero.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), {z: 15, x: 0, y: 0} as CanonicalTileID);

        // Radius 0 (whether default or explicit) must produce byte-identical
        // buckets: the rounding + smooth-normal passes never run.
        expect(base.layoutVertexArray.length).toBeGreaterThan(0);
        expect(explicitZero.layoutVertexArray.length).toBe(base.layoutVertexArray.length);
        expect(explicitZero.indexArray.length).toBe(base.indexArray.length);
        expect(Array.from(explicitZero.layoutVertexArray.int16)).toEqual(Array.from(base.layoutVertexArray.int16));
        expect(Array.from(explicitZero.indexArray.uint16)).toEqual(Array.from(base.indexArray.uint16));
    });

    test('a positive fill-extrusion-edge-radius rounds corners and emits more vertices', () => {
        const availableImages = [];
        const sharp = createFillExtrusionBucket({id: 'sharp', layout: {'fill-extrusion-edge-radius': 0}, availableImages});
        sharp.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), {z: 15, x: 0, y: 0} as CanonicalTileID);

        const rounded = createFillExtrusionBucket({id: 'rounded', layout: {'fill-extrusion-edge-radius': 8}, availableImages});
        rounded.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), {z: 15, x: 0, y: 0} as CanonicalTileID);

        // Rounding replaces each qualifying sharp corner with a 4-point arc, so
        // the rounded bucket must contain strictly more geometry.
        expect(rounded.layoutVertexArray.length).toBeGreaterThan(sharp.layoutVertexArray.length);
        expect(rounded.indexArray.length).toBeGreaterThan(sharp.indexArray.length);
    });
});

describe('roundRingCorners', () => {
    test('golden: a square ring rounds each corner into a 4-point arc', () => {
        // Closed CCW square, side 100. radiusUnits 20, so cut = 20 at every 90° corner.
        const square = ring([0, 0], [100, 0], [100, 100], [0, 100], [0, 0]);
        const rounded = roundRingCorners(square, 20);

        // 4 corners × 4 points + restored closure = 17.
        expect(toPairs(rounded)).toEqual([
            [0, 20], [2, 9], [9, 2], [20, 0],
            [80, 0], [91, 2], [98, 9], [100, 20],
            [100, 80], [98, 91], [91, 98], [80, 100],
            [20, 100], [9, 98], [2, 91], [0, 80],
            [0, 20]
        ]);
    });

    test('guard 1: triangles (fewer than 4 corners) are left sharp', () => {
        const triangle = ring([0, 0], [100, 0], [50, 100], [0, 0]);
        expect(roundRingCorners(triangle, 20)).toBe(triangle);
    });

    test('guard 2: near-straight corners are not rounded', () => {
        // A square with an extra near-collinear vertex on the top edge (50, 1):
        // that corner's turn is well under the 0.20 rad threshold, so it is kept
        // as-is while the four true 90° corners still round.
        const withStraight = ring([0, 0], [100, 0], [100, 100], [50, 101], [0, 100], [0, 0]);
        const rounded = roundRingCorners(withStraight, 20);
        // The near-straight vertex is preserved verbatim.
        expect(toPairs(rounded)).toContainEqual([50, 101]);
    });

    test('guard 3: corners whose cut would be < 1 are left sharp', () => {
        // Side length 2 → the per-corner cut clamps to inLen*0.5 - 0.5 = 0.5 < 1,
        // so every corner is skipped and the footprint keeps its exact corners.
        const tiny = ring([0, 0], [2, 0], [2, 2], [0, 2], [0, 0]);
        expect(toPairs(roundRingCorners(tiny, 20))).toEqual(toPairs(tiny));
    });
});

describe('roundPolygonCorners', () => {
    test('below ~1.5 tile-units the arc collapses and the polygon is left sharp', () => {
        const polygon = [ring([0, 0], [100, 0], [100, 100], [0, 100], [0, 0])];
        const before = polygon[0];
        // At z15 tileMeters ≈ 1223 m; radiusM 0.2 → ~1.34 units < 1.5 → no-op.
        roundPolygonCorners(polygon, {z: 15, x: 0, y: 0} as CanonicalTileID, 0.2);
        expect(polygon[0]).toBe(before);
    });

    test('a metric radius above the collapse threshold rounds every ring', () => {
        const polygon = [ring([0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0])];
        const before = polygon[0].length;
        roundPolygonCorners(polygon, {z: 15, x: 0, y: 0} as CanonicalTileID, 4);
        expect(polygon[0].length).toBeGreaterThan(before);
    });
});

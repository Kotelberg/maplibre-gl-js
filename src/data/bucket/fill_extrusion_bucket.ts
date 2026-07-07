import {FillExtrusionLayoutArray, PosArray} from '../array_types.g';

import {members as layoutAttributes, centroidAttributes} from './fill_extrusion_attributes';
import {type Segment, SegmentVector} from '../segment';
import {ProgramConfigurationSet} from '../program_configuration';
import {TriangleIndexArray} from '../index_array_type';
import {EXTENT} from '../extent';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
const EARCUT_MAX_RINGS = 500;
import {register} from '../../util/web_worker_transfer';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features';
import {loadGeometry} from '../load_geometry';
import {toEvaluationFeature} from '../evaluation_feature';
import {EvaluationParameters} from '../../style/evaluation_parameters';

import type {CanonicalTileID} from '../../tile/tile_id';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket';

import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import type {Context} from '../../gl/context';
import type {IndexBuffer} from '../../gl/index_buffer';
import type {VertexBuffer} from '../../gl/vertex_buffer';
import Point from '@mapbox/point-geometry';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';
import {subdividePolygon, subdivideVertexLine} from '../../render/subdivision';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

const FACTOR = Math.pow(2, 13);

function addVertex(vertexArray, x, y, nx, ny, nz, t, e) {
    vertexArray.emplaceBack(
        // a_pos
        x,
        y,
        // a_normal_ed: 3-component normal and 1-component edgedistance
        Math.floor(nx * FACTOR) * 2 + t,
        ny * FACTOR * 2,
        nz * FACTOR * 2,
        // edgedistance (used for wrapping patterns around extrusion sides)
        Math.round(e)
    );
}

type CentroidAccumulator = {
    x: number;
    y: number;
    sampleCount: number;
};

export class FillExtrusionBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillExtrusionStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillExtrusionStyleLayer>;
    stateDependentLayerIds: Array<string>;

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: PosArray;
    centroidVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;
    features: Array<BucketFeature>;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasDependencies = false;

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new PosArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID) {
        this.features = [];
        this.hasDependencies = hasPattern('fill-extrusion', this.layers, options);

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const needGeometry = this.layers[0]._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom), evaluationFeature, canonical)) continue;

            const bucketFeature: BucketFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            if (this.hasDependencies) {
                this.features.push(addPatternDependencies('fill-extrusion', this.layers, bucketFeature, {zoom: this.zoom}, options));
            } else {
                this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.index, true);
        }
    }

    addFeatures(options: PopulateParameters, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}) {
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry, feature.index, canonical, imagePositions, options.subdivisionGranularity);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {[_: string]: ImagePosition}) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions
        });
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0 && this.centroidVertexArray.length === 0;
    }

    uploadPending() {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members, true);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.centroidVertexBuffer.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}, subdivisionGranularity: SubdivisionGranularitySetting) {
        // Edge radius (in meters) is a constant layout property read once per
        // bucket. At the default of 0 the geometry and wall normals are left
        // untouched, so the bucket output stays byte-identical to a build
        // without this feature.
        const edgeRadius = this.layers[0].layout.get('fill-extrusion-edge-radius');
        const smoothNormals = edgeRadius > 0;

        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            if (smoothNormals) {
                roundPolygonCorners(polygon, canonical, edgeRadius);
            }

            // Compute polygon centroid to calculate elevation in GPU
            const centroid: CentroidAccumulator = {x: 0, y: 0, sampleCount: 0};
            const oldVertexCount = this.layoutVertexArray.length;
            this.processPolygon(centroid, canonical, feature, polygon, subdivisionGranularity, smoothNormals);

            const addedVertices = this.layoutVertexArray.length - oldVertexCount;

            const centroidX = Math.floor(centroid.x / centroid.sampleCount);
            const centroidY = Math.floor(centroid.y / centroid.sampleCount);

            for (let i = 0; i < addedVertices; i++) {
                this.centroidVertexArray.emplaceBack(
                    centroidX,
                    centroidY
                );
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }

    private processPolygon(
        centroid: CentroidAccumulator,
        canonical: CanonicalTileID,
        feature: BucketFeature,
        polygon: Array<Array<Point>>,
        subdivisionGranularity: SubdivisionGranularitySetting,
        smoothNormals: boolean
    ): void {
        if (polygon.length < 1) {
            return;
        }

        if (isEntirelyOutside(polygon[0])) {
            return;
        }

        // Only consider the un-subdivided polygon outer ring for centroid calculation
        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            // Here we don't mind if a hole ring is entirely outside, unlike when generating geometry later.
            accumulatePointsToCentroid(centroid, ring);
        }

        const segmentReference = {
            segment: this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray)
        };
        const granularity = subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
        const isPolygon = VectorTileFeature.types[feature.type] === 'Polygon';

        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            if (isEntirelyOutside(ring)) {
                continue;
            }

            const subdividedRing = subdivideVertexLine(ring, granularity, isPolygon);
            this._generateSideFaces(subdividedRing, segmentReference, smoothNormals);
        }

        // Only triangulate and draw the area of the feature if it is a polygon
        // Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
        if (!isPolygon)
            return;

        // Do not generate outlines, since outlines already got subdivided earlier.
        const subdividedPolygon = subdividePolygon(polygon, canonical, granularity, false);
        const vertexArray = this.layoutVertexArray;

        fillLargeMeshArrays(
            (x, y) => {
                addVertex(vertexArray, x, y, 0, 0, 1, 1, 0);
            },
            this.segments,
            this.layoutVertexArray,
            this.indexArray,
            subdividedPolygon.verticesFlattened,
            subdividedPolygon.indicesTriangles
        );
    }

    /**
     * Generates side faces for the supplied geometry. Assumes `geometry` to be a line string, like the output of {@link subdivideVertexLine}.
     * For rings, it is assumed that the first and last vertex of `geometry` are equal.
     *
     * When `smoothNormals` is true (edge radius above 0) each wall vertex is given a
     * normal averaged with its neighbouring edge across gentle turns, so a
     * rounded facade — approximated by many short edges — shades as a smooth
     * curve instead of showing facet bands. Sharp corners (turns past the crease
     * angle) keep their distinct edge normals. When false (the default), each
     * wall keeps the stock faceted per-edge perpendicular and the whole
     * smoothing pass is skipped, preserving byte-identical output.
     */
    private _generateSideFaces(geometry: Array<Point>, segmentReference: {segment: Segment}, smoothNormals: boolean) {
        let edgeDistance = 0;

        // Precompute per-edge normals only when smoothing; at radius 0 the heap
        // allocation and normalization loop are skipped entirely and `perp` is
        // computed inline per-edge exactly as upstream does.
        const nEdges = geometry.length > 1 ? geometry.length - 1 : 0;
        let edgeNrm: Array<Point> | null = null;
        let ringClosed = false;
        if (smoothNormals) {
            edgeNrm = new Array(nEdges);
            for (let e = 0; e < nEdges; e++) {
                edgeNrm[e] = geometry[e + 1].sub(geometry[e])._perp()._unit();
            }
            ringClosed = geometry.length > 2 &&
                geometry[0].x === geometry[geometry.length - 1].x &&
                geometry[0].y === geometry[geometry.length - 1].y;
        }

        // cos(60°): blend turns up to 60°, leave sharper corners faceted.
        const kCreaseCos = 0.5;
        const blendNormal = (base: Point, neighbor: number, hasNeighbor: boolean): Point => {
            if (!hasNeighbor) return base;
            const o = edgeNrm[neighbor];
            if (base.x * o.x + base.y * o.y > kCreaseCos) return base.add(o)._unit();
            return base;
        };

        for (let p = 1; p < geometry.length; p++) {
            const p1 = geometry[p];
            const p2 = geometry[p - 1];

            if (isBoundaryEdge(p1, p2)) {
                continue;
            }

            if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                segmentReference.segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
            }

            // Edge e runs geometry[e] -> geometry[e+1]; here p2 = geometry[e], p1 = geometry[e+1].
            const e = p - 1;
            const perp = smoothNormals ? edgeNrm[e] : p1.sub(p2)._perp()._unit();
            // Smoothed normal at each endpoint (averaged with the adjacent edge
            // across gentle turns, faceted at corners). At radius 0 both stay
            // the stock faceted `perp`.
            let nP1 = perp; // at geometry[e+1] = p1
            let nP2 = perp; // at geometry[e]   = p2
            if (smoothNormals) {
                const prevE = (e === 0) ? nEdges - 1 : e - 1;
                const nextE = (e + 1 >= nEdges) ? 0 : e + 1;
                const hasPrev = (e !== 0) || ringClosed;
                const hasNext = (e + 1 < nEdges) || ringClosed;
                nP1 = blendNormal(perp, nextE, hasNext);
                nP2 = blendNormal(perp, prevE, hasPrev);
            }

            const dist = p2.dist(p1);
            if (edgeDistance + dist > 32768) edgeDistance = 0;

            addVertex(this.layoutVertexArray, p1.x, p1.y, nP1.x, nP1.y, 0, 0, edgeDistance);
            addVertex(this.layoutVertexArray, p1.x, p1.y, nP1.x, nP1.y, 0, 1, edgeDistance);

            edgeDistance += dist;

            addVertex(this.layoutVertexArray, p2.x, p2.y, nP2.x, nP2.y, 0, 0, edgeDistance);
            addVertex(this.layoutVertexArray, p2.x, p2.y, nP2.x, nP2.y, 0, 1, edgeDistance);

            const bottomRight = segmentReference.segment.vertexLength;

            // ┌──────┐
            // │ 0  1 │ Counter-clockwise winding order.
            // │      │ Triangle 1: 0 => 2 => 1
            // │ 2  3 │ Triangle 2: 1 => 2 => 3
            // └──────┘
            this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
            this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

            segmentReference.segment.vertexLength += 4;
            segmentReference.segment.primitiveLength += 2;
        }
    }
}

/**
 * Accumulates geometry to centroid. Geometry can be either a polygon ring, a line string or a closed line string.
 * In case of a polygon ring or line ring, the last vertex is ignored if it is the same as the first vertex.
 */
function accumulatePointsToCentroid(centroid: CentroidAccumulator, geometry: Array<Point>): void {
    for (let i = 0; i < geometry.length; i++) {
        const p = geometry[i];

        if (i === geometry.length - 1 && geometry[0].x === p.x && geometry[0].y === p.y) {
            continue;
        }

        centroid.x += p.x;
        centroid.y += p.y;
        centroid.sampleCount++;
    }
}

register('FillExtrusionBucket', FillExtrusionBucket, {omit: ['layers', 'features']});

function isBoundaryEdge(p1, p2) {
    return (p1.x === p2.x && (p1.x < 0 || p1.x > EXTENT)) ||
        (p1.y === p2.y && (p1.y < 0 || p1.y > EXTENT));
}

// Rounded footprint corners (the plan-view half of fill-extrusion-edge-radius).
// Sharp building corners are replaced by short arcs, softening silhouettes and
// wall shading. The radius is configured in meters via the
// fill-extrusion-edge-radius layout property and converted to tile units per
// canonical zoom.
const kEarthCircumference = 40075016.686;

/**
 * Rounds the corners of a single footprint ring by replacing each sharp corner
 * with a short quadratic-bezier arc. Rings arrive closed (first === last) and
 * the result restores that closure. Degenerate cases (triangles, near-straight
 * corners, edges too short to support a cut) are left untouched so a large
 * radius degrades gracefully instead of producing broken geometry.
 */
export function roundRingCorners(ring: Array<Point>, radiusUnits: number): Array<Point> {
    // Rings arrive closed (first === last); operate on the open form.
    let n = ring.length;
    const closed = n >= 2 && ring[0].x === ring[n - 1].x && ring[0].y === ring[n - 1].y;
    if (closed) {
        n -= 1;
    }
    if (n < 4) {
        // Triangles keep their sharpness — rounding degenerates them.
        return ring;
    }

    const out: Array<Point> = [];
    const push = (x: number, y: number) => {
        out.push(new Point(Math.round(x), Math.round(y)));
    };
    for (let i = 0; i < n; i++) {
        const a = ring[(i + n - 1) % n];
        const b = ring[i];
        const c = ring[(i + 1) % n];

        const inVecX = b.x - a.x;
        const inVecY = b.y - a.y;
        const outVecX = c.x - b.x;
        const outVecY = c.y - b.y;
        const inLen = Math.sqrt(inVecX * inVecX + inVecY * inVecY);
        const outLen = Math.sqrt(outVecX * outVecX + outVecY * outVecY);
        if (inLen < 1e-6 || outLen < 1e-6) {
            out.push(b);
            continue;
        }

        // Skip near-straight corners: rounding them only adds vertices.
        const cross = inVecX * outVecY - inVecY * outVecX;
        const dot = inVecX * outVecX + inVecY * outVecY;
        const turn = Math.abs(Math.atan2(cross, dot));
        if (turn < 0.20) {
            out.push(b);
            continue;
        }

        // Clamp the cut so adjacent corners never overlap.
        const cut = Math.min(radiusUnits, inLen * 0.5 - 0.5, outLen * 0.5 - 0.5);
        if (cut < 1.0) {
            out.push(b);
            continue;
        }

        const inDirX = inVecX / inLen;
        const inDirY = inVecY / inLen;
        const outDirX = outVecX / outLen;
        const outDirY = outVecY / outLen;
        const startX = b.x - inDirX * cut;
        const startY = b.y - inDirY * cut;
        const endX = b.x + outDirX * cut;
        const endY = b.y + outDirY * cut;
        // Quadratic bezier (control point = the original corner) sampled at
        // t = 1/3 and 2/3: enough segments to read round at building scale
        // without exploding vertex counts.
        const mid1X = startX * (4.0 / 9.0) + b.x * (4.0 / 9.0) + endX * (1.0 / 9.0);
        const mid1Y = startY * (4.0 / 9.0) + b.y * (4.0 / 9.0) + endY * (1.0 / 9.0);
        const mid2X = startX * (1.0 / 9.0) + b.x * (4.0 / 9.0) + endX * (4.0 / 9.0);
        const mid2Y = startY * (1.0 / 9.0) + b.y * (4.0 / 9.0) + endY * (4.0 / 9.0);

        push(startX, startY);
        push(mid1X, mid1Y);
        push(mid2X, mid2Y);
        push(endX, endY);
    }
    if (out.length < 3) {
        return ring;
    }
    // Restore closure to match the input convention.
    if (closed) {
        out.push(out[0].clone());
    }
    return out;
}

/**
 * Rounds every ring of a classified polygon in place. The radius (meters) is
 * converted to tile units at the tile's canonical zoom; below ~1.5 units the
 * arc collapses to the original corner, so the whole polygon is left sharp.
 */
export function roundPolygonCorners(polygon: Array<Array<Point>>, canonical: CanonicalTileID, radiusM: number) {
    // Tile units per meter at this canonical zoom (equator approximation is
    // fine for a visual radius).
    const tileMeters = kEarthCircumference / Math.pow(2, canonical.z);
    const radiusUnits = radiusM * (EXTENT / tileMeters);
    if (radiusUnits < 1.5) {
        // Below ~1.5 units the arc collapses to the original corner.
        return;
    }
    for (let i = 0; i < polygon.length; i++) {
        polygon[i] = roundRingCorners(polygon[i], radiusUnits);
    }
}

function isEntirelyOutside(ring) {
    return ring.every(p => p.x < 0) ||
        ring.every(p => p.x > EXTENT) ||
        ring.every(p => p.y < 0) ||
        ring.every(p => p.y > EXTENT);
}

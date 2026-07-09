import {mat3, vec3} from 'gl-matrix';

/**
 * A world-space light position in cartesian form. This is exactly the shape produced by
 * `Light.properties.get('position')` in `src/style/light.ts`, whose `LightPositionProperty`
 * evaluates the style's spherical `[radial, azimuthal, polar]` through `sphericalToCartesian`
 * (`src/util/util.ts`). That helper is byte-identical to native's
 * `style::Position::calculateCartesian` (azimuth + 90deg, then
 * `x = r*cos(a)*sin(p)`, `y = r*sin(a)*sin(p)`, `z = r*cos(p)`), so gl-js already hands us the
 * same cartesian sun native's `Position::getCartesian()` feeds into `ShadowSun::direction`.
 */
export type CartesianLightPosition = {x: number; y: number; z: number};

/**
 * Normalized world-space direction from a surface TOWARD the sun, matching fill-extrusion's
 * lighting convention (used as `dot(normal, dir)`). Direct port of native `ShadowSun::direction`
 * (`src/mbgl/renderer/shadows/shadow_sun.cpp:11-34`, committed tree 657952f4).
 *
 * Native takes the spherical `style::Position` and calls `getCartesian()`; gl-js's evaluated light
 * is already cartesian (see {@link CartesianLightPosition}), so we take the cartesian value
 * directly — the spherical to cartesian step lives in `LightPositionProperty.possiblyEvaluate`.
 *
 * World frame (shared with the frustum fit, which works in mercator world-pixels): x east, y south
 * (mercator y grows downward), z up. Native's frame is identical (matrixFor units), so no axis
 * remap is needed.
 *
 * `anchor: "map"` (the supported config, spec §3.9) ignores bearing, giving a world-anchored,
 * bearing-invariant sun. `anchor: "viewport"` rotates the ground (x,y) by minus-bearing about z, so
 * shadows crawl under rotation (documented limitation, NOT a bug to fix).
 */
export function shadowSunDirection(
    position: CartesianLightPosition,
    anchor: 'map' | 'viewport',
    bearingRadians: number
): [number, number, number] {
    let x = position.x;
    let y = position.y;
    const z = position.z;

    if (anchor === 'viewport') {
        // Native rotates a mat3 by -bearing and transforms the direction; a pure z-rotation only
        // touches the ground (x,y) components. We use gl-matrix directly (mathematically correct
        // rotation) rather than reproducing native's known aliasing quirk in transformMat3f —
        // viewport-anchored shadows crawl regardless, and this branch never runs under the supported
        // map anchor, so FE shading and shadows stay consistent there.
        const m = mat3.create();
        mat3.rotate(m, m, -bearingRadians);
        const v = vec3.fromValues(x, y, z);
        vec3.transformMat3(v, v, m);
        x = v[0];
        y = v[1];
    }

    const len = Math.sqrt(x * x + y * y + z * z);
    const inv = len > 0 ? 1 / len : 0;
    return [x * inv, y * inv, z * inv];
}

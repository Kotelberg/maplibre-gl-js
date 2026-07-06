import {describe, expect, test} from 'vitest';
import {coverSignature} from './model_placement';
import {OverscaledTileID} from '../../tile/tile_id';

const tile = (z: number, x: number, y: number) => new OverscaledTileID(z, 0, z, x, y);

describe('coverSignature', () => {
    test('is stable and order-independent for the same tile set', () => {
        const a = [tile(16, 100, 200), tile(16, 101, 200), tile(16, 100, 201)];
        const b = [tile(16, 100, 200), tile(16, 101, 200), tile(16, 100, 201)];
        expect(coverSignature(a)).toBe(coverSignature(b));
    });

    test('changes when a tile is added or removed (the rebuild trigger)', () => {
        const base = [tile(16, 100, 200), tile(16, 101, 200)];
        const added = [...base, tile(16, 100, 201)];
        expect(coverSignature(base)).not.toBe(coverSignature(added));
        expect(coverSignature(base)).not.toBe(coverSignature([tile(16, 100, 200)]));
    });

    test('distinguishes tiles differing only in z, x, or y', () => {
        expect(coverSignature([tile(16, 100, 200)])).not.toBe(coverSignature([tile(17, 100, 200)]));
        expect(coverSignature([tile(16, 100, 200)])).not.toBe(coverSignature([tile(16, 101, 200)]));
        expect(coverSignature([tile(16, 100, 200)])).not.toBe(coverSignature([tile(16, 100, 201)]));
    });

    test('the empty cover has the FNV-1a offset-basis seed (decimal uint64)', () => {
        expect(coverSignature([])).toBe('1469598103934665603');
    });
});

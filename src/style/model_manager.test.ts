import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test, vi} from 'vitest';
import {ModelManager} from './model_manager';
import {RequestManager} from '../util/request_manager';

const HOUSE_GLB_PATH = path.join(__dirname, '../../test/unit/assets/house.glb');

function readFixture(): ArrayBuffer {
    const buf = readFileSync(HOUSE_GLB_PATH);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('ModelManager', () => {
    test('registers and bakes an in-memory GLB ArrayBuffer', async () => {
        const onChange = vi.fn();
        const manager = new ModelManager(new RequestManager(), onChange);

        // Loading bumps the version and reports the model as present-but-not-ready.
        const promise = manager.addModel('house', readFixture());
        expect(manager.hasModel('house')).toBe(true);
        expect(manager.getModel('house')).toBeNull();
        expect(manager.version).toBe(1);

        await promise;

        // Once baked, getModel returns the valid mesh and version bumped again.
        const model = manager.getModel('house');
        expect(model).not.toBeNull();
        expect(model!.valid).toBe(true);
        expect(model!.parts.length).toBe(5); // native's house.glb bakes to 5 shade-bucketed parts
        expect(manager.version).toBe(2);
        expect(onChange).toHaveBeenCalledTimes(2);
        expect(manager.listModels()).toEqual(['house']);
    });

    test('removeModel drops the entry and falls back to null', () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        manager.addModel('house', readFixture());
        expect(manager.hasModel('house')).toBe(true);
        manager.removeModel('house');
        expect(manager.hasModel('house')).toBe(false);
        expect(manager.getModel('house')).toBeNull();
        expect(manager.listModels()).toEqual([]);
    });

    test('a failed parse marks the model as an error (placeholder fallback via null)', async () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        // Not a valid GLB container.
        await manager.addModel('broken', new Uint8Array([1, 2, 3, 4]).buffer);
        expect(manager.hasModel('broken')).toBe(true);
        expect(manager.getModel('broken')).toBeNull();
    });

    test('re-registering an id replaces the previous entry', async () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        await manager.addModel('m', readFixture());
        expect(manager.getModel('m')).not.toBeNull();
        // Replace with an invalid buffer.
        await manager.addModel('m', new Uint8Array([0, 0, 0, 0]).buffer);
        expect(manager.getModel('m')).toBeNull();
    });
});

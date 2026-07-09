import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test, vi} from 'vitest';
import {Context} from '../../gl/context';
import {RequestManager} from '../../util/request_manager';
import {ModelManager} from '../../style/model_manager';
import {buildModelGeometry} from './model_geometry';

import type {PlacedInstance} from './model_placement';
import type * as AjaxModule from '../../util/ajax';

vi.mock('../../util/ajax', async (importOriginal) => {
    const actual = await importOriginal<typeof AjaxModule>();
    return {
        ...actual,
        // A URL-backed load that never settles, standing in for a fetch still
        // in flight — `ModelManager` has already flipped the entry to
        // 'loading' by the time this promise is even created (synchronously in
        // `addModel`, before any await), so it's enough that this hangs.
        getArrayBuffer: vi.fn(() => new Promise(() => {}))
    };
});

const HOUSE_GLB_PATH = path.join(__dirname, '../../../test/unit/assets/house.glb');

function readFixture(): ArrayBuffer {
    const buf = readFileSync(HOUSE_GLB_PATH);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function getContext(): Context {
    const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
    return new Context(gl);
}

function instance(modelId: string | undefined): PlacedInstance {
    return {fx: 0.5, fy: 0.5, modelId, scale: 10, rotation: 0, footprint: 1, featureId: undefined};
}

describe('buildModelGeometry model resolution', () => {
    test('a model still loading renders nothing for that feature this frame', async () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        // Loading kicks off synchronously; the mocked getArrayBuffer above never
        // resolves, so the entry stays 'loading' for the lifetime of this test.
        void manager.addModel('pending', 'https://example.com/pending.glb');
        expect(manager.getStatus('pending')).toBe('loading');

        const context = getContext();
        const built = buildModelGeometry(context, [instance('pending')], manager);
        try {
            expect(built.groups).toHaveLength(0);
        } finally {
            built.destroy();
        }
    });

    test('a resolved model draws the real mesh, not the placeholder', async () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        await manager.addModel('house', readFixture());
        expect(manager.getStatus('house')).toBe('loaded');

        const context = getContext();
        const built = buildModelGeometry(context, [instance('house')], manager);
        try {
            expect(built.groups).toHaveLength(1);
            expect(built.groups[0].parts.length).toBeGreaterThan(0);
            // Placeholder parts sample their face-color texture NEAREST; a real
            // baked model never does.
            for (const part of built.groups[0].parts) {
                expect(part.nearest).toBe(false);
            }
        } finally {
            built.destroy();
        }
    });

    test('a failed parse falls back to the placeholder cube', async () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        await manager.addModel('broken', new Uint8Array([1, 2, 3, 4]).buffer);
        expect(manager.getStatus('broken')).toBe('error');

        const context = getContext();
        const built = buildModelGeometry(context, [instance('broken')], manager);
        try {
            expect(built.groups).toHaveLength(1);
            expect(built.groups[0].parts.length).toBeGreaterThan(0);
            for (const part of built.groups[0].parts) {
                expect(part.nearest).toBe(true);
            }
        } finally {
            built.destroy();
        }
    });

    test('an id that was never registered also falls back to the placeholder cube', () => {
        const manager = new ModelManager(new RequestManager(), vi.fn());
        expect(manager.getStatus('unregistered')).toBe('missing');

        const context = getContext();
        const built = buildModelGeometry(context, [instance('unregistered')], manager);
        try {
            expect(built.groups).toHaveLength(1);
            for (const part of built.groups[0].parts) {
                expect(part.nearest).toBe(true);
            }
        } finally {
            built.destroy();
        }
    });
});

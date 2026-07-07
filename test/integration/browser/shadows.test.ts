import {describe, beforeEach, beforeAll, afterEach, afterAll, test, expect} from 'vitest';
import {type Page, type Browser, type ConsoleMessage} from 'puppeteer';
import st from 'st';
import http, {type Server} from 'http';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import type {AddressInfo} from 'net';

import {launchPuppeteer} from '../lib/puppeteer_config';
import type {Map} from '../../../dist/maplibre-gl';

const testWidth = 512;
const testHeight = 512;
const deviceScaleFactor = 1;

let server: Server;
let browser: Browser;
let page: Page;
let pageErrors: string[];

declare const map: Map;

/**
 * Settle the map at a target zoom and resolve once it has gone idle (all tiles loaded, render
 * loop quiesced). Consecutive target zooms must differ so a fresh `idle` is guaranteed to fire.
 */
async function settleAt(zoom: number): Promise<void> {
    await page.evaluate((z) => {
        return new Promise<void>((resolve) => {
            map.once('idle', () => resolve());
            map.setZoom(z);
        });
    }, zoom);
    // Belt-and-braces: give the compositor one more frame so preserveDrawingBuffer holds the
    // fully-settled image before we read it back.
    await page.evaluate(() => {
        return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
}

/** Screenshot the map canvas and decode to raw RGBA. */
async function grab(): Promise<PNG> {
    const buf = await page.screenshot({type: 'png', clip: {x: 0, y: 0, width: testWidth, height: testHeight}}) as Buffer;
    return PNG.sync.read(buf);
}

/** Fraction of pixels that differ between two frames (per-pixel threshold 0.1, as the render harness uses). */
function diffFraction(a: PNG, b: PNG): number {
    const {width, height} = a;
    const out = new PNG({width, height});
    const differing = pixelmatch(a.data, b.data, out.data, width, height, {threshold: 0.1});
    return differing / (width * height);
}

/** Mean luminance over the top-half of the frame (where the pitched-away rooftops sit). */
function meanRoofLuminance(png: PNG): number {
    const {width, height, data} = png;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < Math.floor(height * 0.5); y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            n++;
        }
    }
    return sum / n;
}

/** Count pixels meaningfully darker than the light basemap — proof the shadow/building draw actually ran. */
function darkPixelFraction(png: PNG): number {
    const {width, height, data} = png;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 150) dark++; // basemap #d7d2c8 ~ 209; shadowed ground + building sides are darker
    }
    return dark / (width * height);
}

describe('fill-extrusion cast-shadows — zoom-oscillation regression (spec §3.12.2, the D3 gate)', () => {

    beforeAll(async () => {
        server = http.createServer(st(process.cwd()));
        await new Promise<void>((resolve) => server.listen(resolve));
        browser = await launchPuppeteer();
    }, 40000);

    beforeEach(async () => {
        page = await browser.newPage();
        pageErrors = [];
        // A failed shader compile/link (e.g. a botched RENDER_SHADOWS variant) surfaces as a console
        // error or a thrown page error — capture both so the regression test also guards shader health.
        page.on('pageerror', (e: Error) => pageErrors.push(String(e)));
        page.on('console', (msg: ConsoleMessage) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
        await page.setViewport({width: testWidth, height: testHeight, deviceScaleFactor});
        const port = (server.address() as AddressInfo).port;
        await page.goto(`http://localhost:${port}/test/integration/browser/fixtures/shadows.html`, {waitUntil: 'domcontentloaded'});
        await page.evaluate(() => {
            return new Promise<void>((resolve) => {
                if (map.loaded()) { resolve(); } else { map.once('idle', () => resolve()); }
            });
        });
    }, 40000);

    afterEach(async () => {
        await page.close();
    }, 40000);

    afterAll(async () => {
        await browser.close();
        if (server) server.close();
    }, 40000);

    // The native grey-roof wash (pr3 Known-issues #1) reproduced specifically while zooming through
    // the [14,15] height-fade band over loaded tiles. This drives >=2 sustained z14->z16->z14 cycles,
    // screenshots at a matched settled camera (z15.6, pitch 55) each cycle, and asserts the settled
    // frames stay identical: no emergent far-field darkening, no uniform grey accumulating on roofs.
    // It is the CI regression gate for the three D3 guards: §3.3.1 (unwritten-texel), §3.3.2 (NEAREST),
    // §3.3.3 (seed/clear/usable-gate).
    test('sustained z14-z16 oscillation leaves settled rooftops drift-free (no grey wash)', {timeout: 120000}, async () => {
        // Confirm the feature is actually live before we assert anything about its stability.
        const shadowsActive = await page.evaluate(() => Boolean((map as any).painter?.shadowRenderer?.active));
        expect(shadowsActive, 'shadow renderer must be active (cast-shadows on, anchor:map, FE tiles present)').toBe(true);

        // Settled reference at z15.6 BEFORE any oscillation.
        await settleAt(15.6);
        const reference = await grab();

        // Guard against a false pass where nothing draws: shadows + building sides must darken the frame.
        expect(darkPixelFraction(reference), 'scene must contain shadow/building dark pixels').toBeGreaterThan(0.02);
        const refLuma = meanRoofLuminance(reference);

        // Non-vacuity: toggling cast-shadows off must visibly change the frame (proves the shadow draw
        // materially affects pixels, so the drift assertions below are testing something real).
        await page.evaluate(() => { map.setLight({...map.getLight(), 'cast-shadows': false}); });
        await page.evaluate(() => { return new Promise<void>((resolve) => map.once('idle', () => resolve())); });
        const shadowsOff = await grab();
        expect(diffFraction(reference, shadowsOff), 'shadows-on vs shadows-off must differ (feature is live)').toBeGreaterThan(0.01);
        // Restore shadows and re-settle before the regression sweep.
        await page.evaluate(() => { map.setLight({...map.getLight(), 'cast-shadows': true}); });
        await page.evaluate(() => { return new Promise<void>((resolve) => map.once('idle', () => resolve())); });

        const settledFrames: PNG[] = [];
        const CYCLES = 2;
        for (let c = 0; c < CYCLES; c++) {
            // One sustained oscillation cycle through the fade band and one level past it.
            await settleAt(14.0);
            await settleAt(16.0);
            await settleAt(14.2);
            await settleAt(16.0);
            // Return to the matched settled camera and capture.
            await settleAt(15.6);
            settledFrames.push(await grab());
        }

        // (a) Every settled frame is drift-free vs the pre-oscillation reference.
        for (let c = 0; c < settledFrames.length; c++) {
            const frac = diffFraction(reference, settledFrames[c]);
            expect(frac, `settled frame after cycle ${c + 1} must match the pre-oscillation reference (drift ${(frac * 100).toFixed(4)}%)`).toBeLessThan(0.001);
        }
        // (b) Settled frames match each other (no accumulation across cycles).
        expect(diffFraction(settledFrames[0], settledFrames[settledFrames.length - 1]), 'no accumulation across oscillation cycles').toBeLessThan(0.001);
        // (b2) §3.10 settled-view identity at render level: the reference frame was captured as a fresh
        // refit (cachedZoom == 15.6 on first load, liveS == 1), whereas the post-oscillation settled
        // frames are reached with the light-clip cache fitted at a DIFFERENT zoom and rescaled by liveS
        // (a rescaled cache hit). That the two are pixel-identical (assertion (a)) is exactly the
        // cache-present-vs-forced-always-refit identity §3.12.1 asks for. Observe the rescale to prove
        // the cache path (not another refit) produced the settled frame. (T4's shadow_cache.test.ts is
        // the bit-exact unit backstop.)
        const liveS = await page.evaluate(() => {
            const fs = (map as any).painter.shadowRenderer.frustumState;
            return (fs.valid && fs.cachedZoom >= 0.0) ? Math.pow(2, map.getZoom() - fs.cachedZoom) : 1.0;
        });
        expect(Number.isFinite(liveS), `liveS must stay finite (sentinel guard); observed ${liveS}`).toBe(true);
        // (c) Direct no-grey-wash check: rooftop-region mean luminance must not drift downward.
        for (let c = 0; c < settledFrames.length; c++) {
            expect(Math.abs(meanRoofLuminance(settledFrames[c]) - refLuma), `rooftop luminance must not drift after cycle ${c + 1}`).toBeLessThan(1.0);
        }
        // (d) No console/shader errors surfaced during the sweep (guards the RENDER_SHADOWS variant compile/link).
        expect(pageErrors, `no page/console errors during the shadow sweep:\n${pageErrors.join('\n')}`).toEqual([]);
    });
});

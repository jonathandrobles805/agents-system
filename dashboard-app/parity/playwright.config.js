import { defineConfig } from '@playwright/test';
import { TZ } from './helpers.js';

const TARGET = process.env.PARITY_TARGET ?? 'original';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js/,
  // one worker: some interaction tests append to the fixture's event logs (and restore them); captures must not see that
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: `results/${TARGET}/report.json` }]],
  outputDir: `results/${TARGET}/artifacts`,
  use: {
    browserName: 'chromium',
    // Software raster in one pass. Without these flags two captures of the same page differed by ±1–3 in a colour
    // channel on anti-aliased edges (11–167 px per image; parity/README: determinism check).
    launchOptions: {
      // PARITY_CHROME: another Chrome binary (e.g. on macOS); both builds must be captured with the same one
      executablePath: process.env.PARITY_CHROME || '/usr/bin/google-chrome',
      args: ['--disable-gpu', '--disable-gpu-rasterization', '--disable-partial-raster', '--disable-skia-runtime-opts', '--force-color-profile=srgb', '--disable-threaded-animation', '--disable-checker-imaging'],
    },
    timezoneId: TZ,
    locale: 'en-US',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  },
});

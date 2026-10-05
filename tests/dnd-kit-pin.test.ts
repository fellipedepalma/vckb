import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ImmediateKeyboardSensor (web/src/components/Board.tsx) replaces a private method of dnd-kit's
 * KeyboardSensor and uses its private fields. This test only fails when the installed version moves.
 */
const REVIEWED = { '@dnd-kit/core': '6.3.1', '@dnd-kit/sortable': '10.0.0' } as const;

describe('dnd-kit versions reviewed for ImmediateKeyboardSensor', () => {
  for (const [name, version] of Object.entries(REVIEWED)) {
    it(`${name} is ${version}`, () => {
      const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
      expect(
        installed,
        `${name} is ${installed}, reviewed was ${version}: review ImmediateKeyboardSensor and run the stress test at throttle 6 before bumping (then update REVIEWED in tests/dnd-kit-pin.test.ts)`,
      ).toBe(version);
    });
  }
});

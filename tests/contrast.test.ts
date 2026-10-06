import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function luminance(r: number, g: number, b: number) {
  const a = [r, g, b].map(function (v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function contrast(hex1: string, hex2: string) {
  const getRGB = (hex: string) => {
    let rgb = hex.replace('#', '');
    if (rgb.length === 3) rgb = rgb.split('').map((c) => c + c).join('');
    return [parseInt(rgb.substring(0, 2), 16), parseInt(rgb.substring(2, 4), 16), parseInt(rgb.substring(4, 6), 16)];
  };
  const [r1, g1, b1] = getRGB(hex1);
  const [r2, g2, b2] = getRGB(hex2);
  const lum1 = luminance(r1, g1, b1);
  const lum2 = luminance(r2, g2, b2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

const cssPath = path.resolve(__dirname, '../web/src/styles.css');
const cssContent = readFileSync(cssPath, 'utf-8');
const colors: Record<string, string> = {};
const regex = /--color-([^:]+):\s*(#[0-9a-fA-F]+)/g;
let match;
while ((match = regex.exec(cssContent)) !== null) {
  colors[match[1]] = match[2];
}

const textColors = ['text', 'muted', 'accent', 'accent-2', 'review', 'danger'];
// `bg` is the field background inside the details dialog; `accent` is the Save button.
const bgColors = ['bg', 'surface', 'surface-2'];

const textPairs = bgColors.flatMap((bg) => textColors.map((fg) => ({ fg, bg })));
textPairs.push({ fg: 'done-text', bg: 'done-surface' }, { fg: 'bg', bg: 'accent' });

const borderPairs = [
  { border: 'line-strong', bg: 'bg' },
  { border: 'line-strong', bg: 'surface' },
  { border: 'line-strong', bg: 'surface-2' },
];

describe('WCAG Contrast', () => {
  describe('Text contrast (>= 4.5:1)', () => {
    it.each(textPairs)('$fg on $bg', ({ fg, bg }) => {
      const fgHex = colors[fg];
      const bgHex = colors[bg];
      if (!fgHex || !bgHex) throw new Error(`Missing token ${fg} or ${bg}`);
      const c = contrast(fgHex, bgHex);
      expect(c).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('Border contrast (>= 3:1)', () => {
    it.each(borderPairs)('$border on $bg', ({ border, bg }) => {
      const borderHex = colors[border];
      const bgHex = colors[bg];
      if (!borderHex || !bgHex) throw new Error(`Missing token ${border} or ${bg}`);
      const c = contrast(borderHex, bgHex);
      expect(c).toBeGreaterThanOrEqual(3);
    });
  });
});

/**
 * The rendered Markdown (web/src/markdown.tsx) sits on `bg` (the preview box), code on `surface-2`.
 * Every pair it uses is named here, so removing one from the general matrices above cannot go unnoticed.
 */
describe('Markdown preview pairs', () => {
  const text: [string, string, string][] = [
    ['body text', 'text', 'bg'],
    ['link (accent)', 'accent', 'bg'],
    ['link on hover (text)', 'text', 'bg'],
    ['inline code and code blocks', 'text', 'surface-2'],
    ['quote (muted)', 'muted', 'bg'],
    ['"Nothing to preview" (muted)', 'muted', 'bg'],
    ['plain-text fallback notice (accent-2)', 'accent-2', 'bg'],
    ['active tab (accent)', 'accent', 'surface'],
    ['inactive tab (muted)', 'muted', 'surface'],
    ['inactive tab on hover (text)', 'text', 'surface'],
  ];
  it.each(text)('%s: %s on %s >= 4.5:1', (_what, fg, bg) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });

  const borders: [string, string, string][] = [
    ['preview box', 'line-strong', 'surface'],
    ['quote bar', 'line-strong', 'bg'],
    ['table cells', 'line-strong', 'bg'],
    ['rules', 'line-strong', 'bg'],
    ['active tab underline (accent)', 'accent', 'surface'],
  ];
  it.each(borders)('%s: %s on %s >= 3:1', (_what, border, bg) => {
    expect(contrast(colors[border], colors[bg])).toBeGreaterThanOrEqual(3);
  });
});

import { describe, it } from 'vitest';
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
    if (rgb.length === 3) rgb = rgb.split('').map(c => c + c).join('');
    return [parseInt(rgb.substring(0, 2), 16), parseInt(rgb.substring(2, 2), 16), parseInt(rgb.substring(4, 2), 16)];
  };
  const [r1, g1, b1] = getRGB(hex1);
  const [r2, g2, b2] = getRGB(hex2);
  const lum1 = luminance(r1, g1, b1);
  const lum2 = luminance(r2, g2, b2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('WCAG Contrast', () => {
  it('checks contrast for all defined tokens', () => {
    const cssPath = path.resolve(__dirname, '../web/src/styles.css');
    const cssContent = readFileSync(cssPath, 'utf-8');
    const colors: Record<string, string> = {};
    const regex = /--color-([^:]+):\s*(#[0-9a-fA-F]+)/g;
    let match;
    while ((match = regex.exec(cssContent)) !== null) {
      colors[match[1]] = match[2];
    }

    const checkText = (fgName: string, bgName: string) => {
      const fg = colors[fgName];
      const bg = colors[bgName];
      if (!fg || !bg) throw new Error(`Missing token ${fgName} or ${bgName}`);
      const c = contrast(fg, bg);
      if (c < 4.5) throw new Error(`Contrast between ${fgName} (${fg}) and ${bgName} (${bg}) is ${c.toFixed(2)}, which is below 4.5:1`);
    };

    const checkBorder = (borderName: string, bgName: string) => {
      const border = colors[borderName];
      const bg = colors[bgName];
      if (!border || !bg) throw new Error(`Missing token ${borderName} or ${bgName}`);
      const c = contrast(border, bg);
      if (c < 3) throw new Error(`Contrast between ${borderName} (${border}) and ${bgName} (${bg}) is ${c.toFixed(2)}, which is below 3:1`);
    };

    // Pairs to check for text (>= 4.5:1)
    const textColors = ['text', 'muted', 'accent', 'accent-2', 'review', 'danger'];
    const bgColors = ['bg', 'surface', 'surface-2'];

    for (const bg of bgColors) {
      for (const fg of textColors) {
        checkText(fg, bg);
      }
    }

    // Done column text over Done column surface
    checkText('done-text', 'done-surface');

    // Form borders (>= 3:1) against field backgrounds (usually surface or surface-2 or bg)
    checkBorder('line-strong', 'bg');
    checkBorder('line-strong', 'surface');
    checkBorder('line-strong', 'surface-2');
  });
});

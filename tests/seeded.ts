/** A tiny seeded PRNG (mulberry32), so the property and fuzz tests run the same cases every time. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  return { next, int, pick, chance: (p: number) => next() < p };
}

export type Rng = ReturnType<typeof seeded>;

/** Pieces that mean something to YAML (or to people), glued together to make awkward text. */
export const YAML_TOKENS = [
  'a', 'B', 'z9', '1', '0', ' ', '  ', '\t', ': ', ':', ' #', '#', "'", '"', "''", '\\', '\\n', '---', '...', '- ', '? ', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`', '~',
  'é', '漢', '😀', '​', '‮', 'א', '\u0085', ' ', ' ', '﻿', '\u007f', ' ',
  'null', 'true', 'false', 'yes', 'no', 'on', '0x1f', '1e3', '.inf', '2026-10-01', '<<', '&a', '*a', '!!str', '!!js/function', '=', 'T-001', 'status: done', '## Checklist',
] as const;

/** Text from the pieces above: never empty, never with a leading or trailing space (titles get trimmed). */
export function awkwardText(rng: Rng, { control = false } = {}): string {
  const parts: string[] = Array.from({ length: 1 + rng.int(7) }, () => rng.pick(YAML_TOKENS));
  if (control) parts.push(rng.pick(['\u0000', '\u0001', '\u001b', '\r', '\n', '\ud800']));
  const text = rng.chance(0.5) ? parts.join('') : parts.join(rng.pick(['', ' ', ' ']));
  return text.trim() || 'x';
}

const LABEL_CHARS = 'abcXYZ019_.-éß漢';
/** A label the server accepts (starts with a letter or digit, up to 32 characters). */
export function validLabel(rng: Rng): string {
  const chars = [...LABEL_CHARS];
  const word = (n: number) => Array.from({ length: n }, () => rng.pick(chars)).join('');
  return `${rng.pick([...'abcXYZ019éß漢'])}${word(rng.int(10))}`;
}

/** A random value for an unknown frontmatter field: scalars, lists and mappings, a few levels deep. */
export function extraValue(rng: Rng, depth = 0): unknown {
  const kind = rng.int(depth > 2 ? 5 : 8);
  if (kind === 0) return awkwardText(rng);
  if (kind === 1) return rng.int(100000) - 500;
  if (kind === 2) return rng.chance(0.5);
  if (kind === 3) return null;
  if (kind === 4) return rng.next() * 1000;
  if (kind <= 5) return Array.from({ length: rng.int(4) }, () => extraValue(rng, depth + 1));
  return Object.fromEntries(Array.from({ length: rng.int(4) }, (_, i) => [`k${i}_${validLabel(rng)}`, extraValue(rng, depth + 1)]));
}

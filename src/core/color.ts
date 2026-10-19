/**
 * Colour handling for contrast checks.
 *
 * Tailwind v4 stores theme colours as `oklch()`, v3 as hex. Both are parsed
 * here and reduced to sRGB, because WCAG contrast is defined on sRGB relative
 * luminance.
 *
 * The oklch conversion follows CSS Color 4: a colour outside the sRGB gamut is
 * brought back by reducing its chroma while keeping lightness and hue.
 */

/** An sRGB colour with components in the 0..1 range. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** The alpha channel, 0..1. */
  readonly a: number;
}

/** The WCAG contrast ratio between two colours, and the thresholds it meets. */
export interface ContrastResult {
  /** The contrast ratio, from 1 to 21. */
  readonly ratio: number;
  /** Relative luminance of the foreground. */
  readonly foregroundLuminance: number;
  /** Relative luminance of the background. */
  readonly backgroundLuminance: number;
  /** Passes WCAG AA for normal text (4.5:1). */
  readonly aa: boolean;
  /** Passes WCAG AA for large text (3:1). */
  readonly aaLarge: boolean;
  /** Passes WCAG AAA for normal text (7:1). */
  readonly aaa: boolean;
  /** Passes WCAG AAA for large text (4.5:1). */
  readonly aaaLarge: boolean;
}

const HEX_PATTERN = /^#([0-9a-f]{3,8})$/i;
const RGB_PATTERN = /^rgba?\(([^)]+)\)$/i;
const OKLCH_PATTERN = /^oklch\(([^)]+)\)$/i;
const HSL_PATTERN = /^hsla?\(([^)]+)\)$/i;

/** Parse a CSS colour string into sRGB. Returns null when unsupported. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  if (value === "") return null;

  const hex = HEX_PATTERN.exec(value);
  if (hex) return parseHex(hex[1]!);

  const rgb = RGB_PATTERN.exec(value);
  if (rgb) return parseRgbFunction(rgb[1]!);

  const oklch = OKLCH_PATTERN.exec(value);
  if (oklch) return parseOklch(oklch[1]!);

  const hsl = HSL_PATTERN.exec(value);
  if (hsl) return parseHsl(hsl[1]!);

  return null;
}

function parseHex(digits: string): Rgb | null {
  const expand = (part: string): number => Number.parseInt(part, 16) / 255;
  switch (digits.length) {
    case 3:
      return {
        r: expand(digits[0]! + digits[0]!),
        g: expand(digits[1]! + digits[1]!),
        b: expand(digits[2]! + digits[2]!),
        a: 1,
      };
    case 4:
      return {
        r: expand(digits[0]! + digits[0]!),
        g: expand(digits[1]! + digits[1]!),
        b: expand(digits[2]! + digits[2]!),
        a: expand(digits[3]! + digits[3]!),
      };
    case 6:
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: 1,
      };
    case 8:
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: expand(digits.slice(6, 8)),
      };
    default:
      return null;
  }
}

function parseRgbFunction(body: string): Rgb | null {
  const parts = body
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter((part) => part !== "");
  if (parts.length < 3) return null;

  const channel = (raw: string): number => {
    if (raw.endsWith("%")) return Number.parseFloat(raw) / 100;
    return Number.parseFloat(raw) / 255;
  };

  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
  return {
    r: clamp(channel(parts[0]!)),
    g: clamp(channel(parts[1]!)),
    b: clamp(channel(parts[2]!)),
    a: Number.isFinite(alpha) ? clamp(alpha) : 1,
  };
}

function parseHsl(body: string): Rgb | null {
  const parts = body
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter((part) => part !== "");
  if (parts.length < 3) return null;

  const hue = Number.parseFloat(parts[0]!) / 360;
  const saturation = Number.parseFloat(parts[1]!) / 100;
  const lightness = Number.parseFloat(parts[2]!) / 100;
  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
  if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(lightness)) {
    return null;
  }

  const m2 =
    lightness <= 0.5
      ? lightness * (saturation + 1)
      : lightness + saturation - lightness * saturation;
  const m1 = lightness * 2 - m2;
  return {
    r: clamp(hueToChannel(m1, m2, hue + 1 / 3)),
    g: clamp(hueToChannel(m1, m2, hue)),
    b: clamp(hueToChannel(m1, m2, hue - 1 / 3)),
    a: Number.isFinite(alpha) ? clamp(alpha) : 1,
  };
}

function hueToChannel(m1: number, m2: number, hue: number): number {
  let h = hue;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h * 6 < 1) return m1 + (m2 - m1) * h * 6;
  if (h * 2 < 1) return m2;
  if (h * 3 < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
  return m1;
}

function parseOklch(body: string): Rgb | null {
  const parts = body
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter((part) => part !== "");
  if (parts.length < 3) return null;

  const lightness = parsePercentageOrNumber(parts[0]!);
  const chroma = parsePercentageOrNumber(parts[1]!);
  const hue = Number.parseFloat(parts[2]!);
  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
  if (!Number.isFinite(lightness) || !Number.isFinite(chroma) || !Number.isFinite(hue)) {
    return null;
  }

  const rgb = oklchToRgb(lightness, chroma, hue);
  return {
    ...rgb,
    a: Number.isFinite(alpha) ? clamp(alpha) : 1,
  };
}

/** `63.7%` becomes `0.637`; a plain number is used as is. */
function parsePercentageOrNumber(raw: string): number {
  if (raw.endsWith("%")) return Number.parseFloat(raw) / 100;
  return Number.parseFloat(raw);
}

/**
 * Convert OKLCh to sRGB, reducing chroma when the colour is out of gamut.
 */
export function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
  const mappedChroma = gamutMap(lightness, chroma, hue);
  const [r, g, b] = oklchToLinear(lightness, mappedChroma, hue);
  return { r: gammaEncode(r), g: gammaEncode(g), b: gammaEncode(b), a: 1 };
}

/** OKLab to linear sRGB, without gamut clamping. */
function oklchToLinear(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * Reduce chroma until the colour fits in the sRGB gamut.
 *
 * A binary search over chroma, as described by CSS Color 4. The result
 * differs from a naive clamp by at most a couple of units per channel, which
 * does not affect a WCAG verdict.
 */
function gamutMap(lightness: number, chroma: number, hue: number): number {
  if (inGamut(oklchToLinear(lightness, chroma, hue))) return chroma;

  let low = 0;
  let high = chroma;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear(lightness, mid, hue))) low = mid;
    else high = mid;
  }
  return low;
}

function inGamut([r, g, b]: readonly [number, number, number]): boolean {
  const epsilon = 1e-6;
  return (
    r >= -epsilon &&
    r <= 1 + epsilon &&
    g >= -epsilon &&
    g <= 1 + epsilon &&
    b >= -epsilon &&
    b <= 1 + epsilon
  );
}

/** Linear light to sRGB gamma encoding. */
function gammaEncode(value: number): number {
  const x = clamp(value);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** WCAG relative luminance. */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Composite a translucent colour over an opaque one.
 *
 * Contrast between translucent colours is undefined without a backdrop, so
 * the foreground is composited over the background.
 */
export function composite(foreground: Rgb, background: Rgb): Rgb {
  if (foreground.a >= 1) return foreground;
  const alpha = foreground.a;
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

/**
 * Compute the WCAG contrast ratio between two colours.
 */
export function contrastRatio(foreground: Rgb, background: Rgb): ContrastResult {
  const composited = composite(foreground, background);
  const foregroundLuminance = relativeLuminance(composited);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  return {
    ratio: Math.round(ratio * 100) / 100,
    foregroundLuminance: Math.round(foregroundLuminance * 10000) / 10000,
    backgroundLuminance: Math.round(backgroundLuminance * 10000) / 10000,
    aa: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaa: ratio >= 7,
    aaaLarge: ratio >= 4.5,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

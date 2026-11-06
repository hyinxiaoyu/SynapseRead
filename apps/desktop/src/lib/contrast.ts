/** Linear-light sRGB channels in `0..1`. */
export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** OKLCH (lightness `0..1`, chroma, hue in degrees) to linear sRGB, gamut-clipped. */
function oklchToLinear(l: number, c: number, hue: number): LinearRgb {
  const a = c * Math.cos((hue * Math.PI) / 180);
  const b = c * Math.sin((hue * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: clamp01(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: clamp01(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

/**
 * Parses an opaque `#rgb`, `#rrggbb`, `rgb()`, or `oklch()` color. Colors with
 * transparency are rejected: their contrast depends on what lies beneath.
 */
export function parseOpaqueColor(input: string): LinearRgb {
  const color = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const channel = (index: number) => toLinear(Number.parseInt(full.slice(index, index + 2), 16));
    return { r: channel(0), g: channel(2), b: channel(4) };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\)$/.exec(
    color,
  );
  if (rgb) {
    const alpha = rgb[4];
    if (alpha !== undefined && alpha !== '1' && alpha !== '100%') {
      throw new Error(`not opaque: ${input}`);
    }
    return {
      r: toLinear(Number(rgb[1])),
      g: toLinear(Number(rgb[2])),
      b: toLinear(Number(rgb[3])),
    };
  }
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color);
  if (oklch) {
    const lightness = Number(oklch[1]) / (oklch[2] === '%' ? 100 : 1);
    return oklchToLinear(lightness, Number(oklch[3]), Number(oklch[4]));
  }
  throw new Error(`unsupported color: ${input}`);
}

/** WCAG 2 relative luminance. */
export function relativeLuminance({ r, g, b }: LinearRgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, `1..21`. AA asks 4.5 for body text and 3 for UI parts. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseOpaqueColor(foreground));
  const b = relativeLuminance(parseOpaqueColor(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

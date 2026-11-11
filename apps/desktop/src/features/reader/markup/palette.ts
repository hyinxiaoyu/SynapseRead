/**
 * The highlight colors the app offers. Its own module so the stored defaults and
 * the components that draw swatches can both validate against it without a cycle.
 */
export const ANNOTATION_COLORS = [
  { label: 'Yellow', value: '#fde047' },
  { label: 'Green', value: '#86efac' },
  { label: 'Blue', value: '#93c5fd' },
  { label: 'Pink', value: '#f9a8d4' },
  { label: 'Purple', value: '#c4b5fd' },
] as const satisfies readonly { label: string; value: string }[];

export const isPaletteColor = (value: unknown): value is string =>
  ANNOTATION_COLORS.some((color) => color.value === value);

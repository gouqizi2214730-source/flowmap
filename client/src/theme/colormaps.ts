/** The persisted density families: one catalog powers validation and picker options. */
export const COLORMAP_CATALOG = [
 { id: 'theme', label: 'Theme', hint: 'identity' }, { id: 'flow', label: 'Flow', hint: 'detail' },
 { id: 'inferno', label: 'Inferno', hint: 'warm' }, { id: 'classic', label: 'Classic', hint: 'thermal' },
 { id: 'ice', label: 'Ice', hint: 'cool' }, { id: 'viridis', label: 'Viridis', hint: 'green' },
 { id: 'cividis', label: 'Cividis', hint: 'blueYellow' }, { id: 'mono', label: 'Mono', hint: 'mono' },
] as const;
export type Colormap = typeof COLORMAP_CATALOG[number]['id'];

export function isColormap(value: unknown): value is Colormap {
  return COLORMAP_CATALOG.some(c => c.id === value);
}

// The built-in style gallery: photos live in img/styles/<slug>/1.jpg, 2.jpg ... plus a small
// thumb.webp used on the gallery grid. To add a style, add a folder and one line here.
export const HAIRCUT_STYLES = [
  { slug: '360-waves', label: '360 Waves', count: 4 },
  { slug: 'afro-taper', label: 'Afro Taper', count: 4 },
  { slug: 'burst-fade', label: 'Burst Fade', count: 3 },
  { slug: 'drop-fade', label: 'Drop Fade', count: 3 },
  { slug: 'high-fade', label: 'High Fade', count: 4 },
  { slug: 'mid-fade', label: 'Mid Fade', count: 4 },
  { slug: 'low-fade', label: 'Low Fade', count: 4 },
  { slug: 'afro-lineup', label: 'Short Afro + Line-up', count: 3, files: [1, 3, 4] },
  { slug: 'locs-fade', label: 'Locs + Fade', count: 4 },
  { slug: 'temp-fade-lineup', label: 'Temp Fade + Line-up', count: 3 },
];

export const styleThumb = (style) => `img/styles/${style.slug}/thumb.webp`;

export function stylePhotos(style) {
  const nums = style.files || Array.from({ length: style.count }, (_, i) => i + 1);
  return nums.map((n) => `img/styles/${style.slug}/${n}.jpg`);
}

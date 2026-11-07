/**
 * Pemetaan koordinat antara viewport halaman bot (px CSS) dan gambar Live di layar.
 *
 * Gambar Live ditampilkan dengan `object-contain`: diperkecil seutuhnya ke dalam kotaknya lalu
 * diletakkan di tengah. Frame screencast mempertahankan rasio viewport, jadi rasio itulah yang
 * menentukan letak gambar. Satu fungsi ini dipakai overlay aksi dan (nanti) input ambil alih.
 */

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** Letak isi gambar di dalam kotaknya: geser kiri/atas dan skala viewport → layar. */
export type Fit = { left: number; top: number; scale: number };

export function fitContain(container: Size, viewport: Size): Fit | undefined {
  if (container.width <= 0 || container.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return undefined;
  }
  const scale = Math.min(container.width / viewport.width, container.height / viewport.height);
  return {
    left: (container.width - viewport.width * scale) / 2,
    top: (container.height - viewport.height * scale) / 2,
    scale,
  };
}

/** Titik viewport → titik di dalam kotak gambar. */
export function toScreen(point: Point, fit: Fit): Point {
  return { x: fit.left + point.x * fit.scale, y: fit.top + point.y * fit.scale };
}

/** Titik di dalam kotak gambar → titik viewport; `undefined` kalau jatuh di pita kosong sekitar gambar. */
export function toViewport(point: Point, fit: Fit, viewport: Size): Point | undefined {
  const x = (point.x - fit.left) / fit.scale;
  const y = (point.y - fit.top) / fit.scale;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return undefined;
  return { x, y };
}

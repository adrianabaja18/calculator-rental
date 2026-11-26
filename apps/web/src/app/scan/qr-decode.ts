import jsQR from 'jsqr';

/**
 * QR decoding ON THE PHONE (the photo never leaves it).
 *
 * 1. The browser's own BarcodeDetector when it has one (Android Chrome:
 *    fast and very good with blur and glare).
 * 2. Otherwise jsQR, tried at several sizes, on the whole picture and on
 *    its centre (a small QR on an ID), with and without a contrast boost
 *    (dim rooms, faded or dirty IDs) and both light-on-dark and dark-on-light.
 *
 * `wanted` says which text we're after (a school ID), so a different QR in
 * the picture doesn't stop the search.
 */

export type Decoded = { text: string | null; sawOtherQr: boolean };

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
let detector: DetectorLike | null | undefined;

function nativeDetector(): DetectorLike | null {
  if (detector !== undefined) return detector;
  const Ctor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  try {
    detector = Ctor ? new Ctor({ formats: ['qr_code'] }) : null;
  } catch {
    detector = null;
  }
  return detector;
}

async function detectNative(source: CanvasImageSource): Promise<string[]> {
  const d = nativeDetector();
  if (!d) return [];
  try {
    return (await d.detect(source)).map((b) => b.rawValue).filter(Boolean);
  } catch {
    return [];
  }
}

type Rect = { x: number; y: number; w: number; h: number };

function pixels(source: CanvasImageSource, crop: Rect, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(crop.w, crop.h));
  const w = Math.max(1, Math.round(crop.w * scale));
  const h = Math.max(1, Math.round(crop.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Grey + stretch the 2nd–98th percentile of brightness to full black–white. */
function boostContrast(img: ImageData): ImageData {
  const d = img.data;
  const grey = new Uint8ClampedArray(d.length / 4);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const y = (d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8;
    grey[p] = y;
    hist[y]!++;
  }
  const lowCount = grey.length * 0.02;
  const highCount = grey.length * 0.98;
  let lo = -1;
  let hi = -1;
  for (let v = 0, sum = 0; v < 256; v++) {
    sum += hist[v]!;
    if (lo < 0 && sum > lowCount) lo = v;
    if (hi < 0 && sum >= highCount) hi = v;
  }
  const range = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(d.length);
  for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
    const v = ((grey[p]! - lo) * 255) / range;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return new ImageData(out, img.width, img.height);
}

function readJsQr(img: ImageData, inversion: 'dontInvert' | 'attemptBoth'): string | null {
  return jsQR(img.data, img.width, img.height, { inversionAttempts: inversion })?.data || null;
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

async function loadPicture(file: File): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** A photo from the camera or the gallery. Thorough (a few seconds at most). */
export async function decodePhoto(file: File, wanted: (text: string) => boolean): Promise<Decoded> {
  const { source, width, height } = await loadPicture(file);
  let sawOtherQr = false;
  const check = (text: string | null) => {
    if (text === null) return false;
    if (wanted(text)) return true;
    sawOtherQr = true;
    return false;
  };

  for (const text of await detectNative(source)) if (check(text)) return { text, sawOtherQr };

  const whole: Rect = { x: 0, y: 0, w: width, h: height };
  const centre: Rect = { x: width * 0.2, y: height * 0.2, w: width * 0.6, h: height * 0.6 };
  for (const [crop, maxSide] of [[whole, 1000], [centre, 1000], [whole, 1600], [centre, 1600], [whole, 640]] as const) {
    await nextTick(); // let the "Reading…" spinner paint
    const img = pixels(source, crop, maxSide);
    for (const attempt of [img, boostContrast(img)]) {
      const text = readJsQr(attempt, 'attemptBoth');
      if (check(text)) return { text, sawOtherQr };
    }
  }
  return { text: null, sawOtherQr };
}

let frameCount = 0;

/** One live camera frame. Quick, so it can run several times a second. */
export async function decodeFrame(video: HTMLVideoElement, wanted: (text: string) => boolean): Promise<Decoded> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return { text: null, sawOtherQr: false };

  const native = nativeDetector() ? await detectNative(video) : null;
  let texts: string[];
  if (native) {
    texts = native;
  } else {
    // Alternate plain / contrast-boosted frames to stay fast.
    const img = pixels(video, { x: 0, y: 0, w: width, h: height }, 720);
    const text = readJsQr(frameCount++ % 2 === 0 ? img : boostContrast(img), 'dontInvert');
    texts = text ? [text] : [];
  }
  const hit = texts.find(wanted) ?? null;
  return { text: hit, sawOtherQr: hit === null && texts.length > 0 };
}

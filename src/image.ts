/** Indlæser et foto (med korrekt EXIF-rotation) og skalerer det ned til max `maxSide` pixels. */
export async function loadAndResize(file: Blob, maxSide = 3000): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  return { blob, width, height };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Kunne ikke konvertere billedet"))), type, quality),
  );
}

/** Tegner billedet ned i en canvas med højst `maxSide` pixels på længste led. */
export function scaledCanvas(img: CanvasImageSource & { width: number; height: number }, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Base64-JPEG under API'ets grænse på 5 MB pr. billede. */
export async function toBase64Jpeg(canvas: HTMLCanvasElement): Promise<string> {
  for (const q of [0.88, 0.75, 0.6, 0.45]) {
    const blob = await canvasToBlob(canvas, "image/jpeg", q);
    if (blob.size < 3.7 * 1024 * 1024) return blobToBase64(blob);
  }
  throw new Error("Billedet er for stort til at sende");
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Roterer et billede 90° med uret. */
export async function rotateBlob90(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.height;
  c.height = bmp.width;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { blob: await canvasToBlob(c, "image/jpeg", 0.92), width: c.width, height: c.height };
}

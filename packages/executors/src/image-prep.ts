/**
 * Prepares reference images for recipes that need an exact input size (the LTX graph needs 576x1024).
 * @packageDocumentation
 */
import sharp from "sharp";

/** Center-crops to the target aspect ratio and Lanczos-scales to exactly width x height, writing a PNG. */
export async function fitImage(inputPath: string, width: number, height: number, outputPath: string): Promise<{ width: number; height: number }> {
  const info = await sharp(inputPath, { failOn: "warning", limitInputPixels: 40_000_000 })
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre", kernel: "lanczos3" })
    .png()
    .toFile(outputPath);
  return { width: info.width, height: info.height };
}

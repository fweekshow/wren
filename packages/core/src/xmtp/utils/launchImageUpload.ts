import { createHash } from "node:crypto";

const MAX_LAUNCH_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_UPLOAD_FOLDER = "token-launches";

export function isLaunchImageSkip(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "skip" || t === "no" || t === "n" || t === "none";
}

export function isLaunchImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

export function isLaunchImageSizeOk(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_LAUNCH_IMAGE_BYTES;
}

function cloudinaryUploadSignature(
  params: Record<string, string | number>,
  apiSecret: string,
): string {
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(paramString + apiSecret).digest("hex");
}

/**
 * Upload decrypted launch image bytes to Cloudinary.
 * Returns secure_url (HTTPS) suitable for Bankr's deploy `image` field.
 */
export async function uploadLaunchImage(
  data: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    console.warn(
      "⚠️ launch image upload: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET not set",
    );
    return null;
  }

  const folder = process.env.CLOUDINARY_UPLOAD_FOLDER?.trim() || DEFAULT_UPLOAD_FOLDER;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = cloudinaryUploadSignature({ folder, timestamp }, apiSecret);

  const safeName = filename.replace(/[^\w.\-]/g, "_") || "launch-image.jpg";
  const blob = new Blob([data], { type: mimeType || "image/jpeg" });
  const form = new FormData();
  form.append("file", blob, safeName);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.warn("⚠️ Cloudinary image upload failed:", res.status, errText);
      return null;
    }

    const json = (await res.json()) as { secure_url?: string };
    const url = json.secure_url?.trim();
    if (!url || !url.startsWith("https://")) return null;
    return url;
  } catch (err) {
    console.warn("⚠️ Cloudinary upload threw:", err);
    return null;
  }
}

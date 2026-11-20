/**
 * Host token metadata JSON (name/symbol/image + socials) for Doppler tokenURI.
 *
 * Prefer IPFS (Pinata) so tokens meet Doppler indexer standards
 * (tokenURI on IPFS with an image field that is itself an IPFS CID).
 * Cloudinary remains a mirror for our own UI when configured.
 * Falls back to a data: URI only when neither provider is available.
 */

import { createHash } from "node:crypto";

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

export type LaunchMetadata = {
  name: string;
  symbol: string;
  image?: string;
  description?: string;
  x?: string;
  telegram?: string;
  farcaster?: string;
  discord?: string;
};

type MetadataPayload = {
  name: string;
  symbol: string;
  image: string;
  description: string;
  x: string;
  telegram: string;
  farcaster: string;
  discord: string;
};

function buildPayload(meta: LaunchMetadata): MetadataPayload {
  return {
    name: meta.name,
    symbol: meta.symbol,
    image: meta.image ?? "",
    description: meta.description ?? "",
    x: meta.x ?? "",
    telegram: meta.telegram ?? "",
    farcaster: meta.farcaster ?? "",
    discord: meta.discord ?? "",
  };
}

/** Pin raw bytes to Pinata. Returns ipfs://CID or null. */
async function pinBytesToIpfs(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) return null;

  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: mimeType }), filename);
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: filename }),
  );

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.warn("⚠️ Pinata pin failed:", res.status, errText);
      return null;
    }
    const json = (await res.json()) as { IpfsHash?: string };
    const cid = json.IpfsHash?.trim();
    return cid ? `ipfs://${cid}` : null;
  } catch (err) {
    console.warn("⚠️ Pinata pin threw:", err);
    return null;
  }
}

/** If image is an https URL, fetch + re-pin to IPFS so the metadata image field is a CID. */
async function ensureIpfsImage(imageUrl: string | undefined): Promise<string> {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("ipfs://")) return imageUrl;

  if (!imageUrl.startsWith("https://")) return imageUrl;

  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) return imageUrl;

  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return imageUrl;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const buf = new Uint8Array(await res.arrayBuffer());
    const pinned = await pinBytesToIpfs(buf, `token-image.${mime.split("/")[1] || "png"}`, mime);
    return pinned ?? imageUrl;
  } catch (err) {
    console.warn("⚠️ Failed to re-pin launch image to IPFS:", err);
    return imageUrl;
  }
}

async function uploadJsonToCloudinary(payload: string, symbol: string): Promise<string | null> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;

  const folder = process.env.CLOUDINARY_UPLOAD_FOLDER?.trim() || "token-launches";
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `meta_${symbol}_${timestamp}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const signature = cloudinaryUploadSignature(
    { folder, public_id: publicId, timestamp },
    apiSecret,
  );

  const blob = new Blob([payload], { type: "application/json" });
  const form = new FormData();
  form.append("file", blob, `${publicId}.json`);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.warn("⚠️ Cloudinary metadata upload failed:", res.status, errText);
      return null;
    }
    const json = (await res.json()) as { secure_url?: string };
    const url = json.secure_url?.trim();
    return url?.startsWith("https://") ? url : null;
  } catch (err) {
    console.warn("⚠️ Cloudinary metadata upload threw:", err);
    return null;
  }
}

/**
 * Returns an ipfs:// (preferred), HTTPS Cloudinary mirror, or data: URI
 * pointing at token metadata JSON.
 */
export async function uploadLaunchMetadata(meta: LaunchMetadata): Promise<string> {
  const image = await ensureIpfsImage(meta.image);
  const body = buildPayload({ ...meta, image });
  const payload = JSON.stringify(body);

  const ipfsUri = await pinBytesToIpfs(
    new TextEncoder().encode(payload),
    `meta_${meta.symbol || "token"}.json`,
    "application/json",
  );
  if (ipfsUri) {
    // Best-effort Cloudinary mirror for our own UI; ignore failures.
    void uploadJsonToCloudinary(payload, meta.symbol);
    return ipfsUri;
  }

  const cloudinary = await uploadJsonToCloudinary(payload, meta.symbol);
  if (cloudinary) return cloudinary;

  return `data:application/json;base64,${Buffer.from(payload, "utf8").toString("base64")}`;
}

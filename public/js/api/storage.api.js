import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

import { storage } from "../firebase.js";
import { t as i18nT } from "../i18n/index.js";

/**
 * Comprimi/ridimensiona un'immagine lato client prima dell'upload.
 * - Safe per Safari
 * - Converte in JPEG (poster quasi sempre ok)
 */
async function compressImageFile(file, {
  maxWidth = 900,
  maxHeight = 1350,
  quality = 0.82,
  mimeType = "image/jpeg",
} = {}) {
  if (!file || !file.type?.startsWith("image/")) return file;

  // Prova createImageBitmap (più veloce), fallback su <img>
  let src;
  try {
    src = await createImageBitmap(file);
  } catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  const srcW = src.width;
  const srcH = src.height;

  // Non upscalare mai
  const ratio = Math.min(maxWidth / srcW, maxHeight / srcH, 1);
  const dstW = Math.round(srcW * ratio);
  const dstH = Math.round(srcH * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = dstW;
  canvas.height = dstH;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dstW, dstH);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality);
  });

  if (!blob) return file;

  const baseName = String(file.name || "poster").replace(/\.\w+$/, "");
  const outName = `${baseName}.jpg`;
  return new File([blob], outName, { type: mimeType, lastModified: Date.now() });
}

/**
 * Upload avatar image (256x256 max), return download URL.
 * Path: avatars/{uid}/avatar.jpg
 */
export async function uploadAvatar({ file, uid }) {
  if (!file) throw new Error(i18nT("Nessun file selezionato."));
  if (!uid) throw new Error("UID mancante.");

  const MAX_SIZE = 2 * 1024 * 1024; // 2MB
  if (file.size > MAX_SIZE) throw new Error("Immagine troppo grande (max 2MB).");

  const compressed = await compressImageFile(file, {
    maxWidth: 256,
    maxHeight: 256,
    quality: 0.85,
    mimeType: "image/jpeg",
  });

  const path = `avatars/${uid}/avatar.jpg`;
  const r = ref(storage, path);
  await uploadBytes(r, compressed, { contentType: "image/jpeg" });

  const url = await getDownloadURL(r);
  return { url, path };
}

/**
 * Download an external image (e.g. Wikimedia thumb), compress to a tiny square,
 * and cache it on Firebase Storage.
 *
 * Path: peopleAvatars/{personId}.jpg
 *
 * If the final compressed image is still above maxBytes, the function throws
 * (caller should fallback to the external URL).
 */
export async function uploadPersonAvatarFromUrl({ url, personId, maxBytes = 50 * 1024 } = {}) {
  if (!url) throw new Error("URL mancante");
  if (!personId) throw new Error("personId mancante");

  // Fetch image
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Fetch avatar fallita (${res.status})`);
  const blob = await res.blob();

  // Quick guard: if Wikimedia thumb is already huge (rare), deny.
  if (blob.size > Math.max(maxBytes * 6, 600 * 1024)) {
    throw new Error("Avatar troppo grande (deny)");
  }

  const tmpFile = new File([blob], `${personId}.jpg`, {
    type: blob.type || 'image/jpeg',
    lastModified: Date.now(),
  });

  const compressed = await compressImageFile(tmpFile, {
    maxWidth: 96,
    maxHeight: 96,
    quality: 0.78,
    mimeType: 'image/jpeg',
  });

  if (compressed.size > maxBytes) {
    throw new Error("Avatar compresso troppo grande (deny)");
  }

  const path = `peopleAvatars/${personId}.jpg`;
  const r = ref(storage, path);
  await uploadBytes(r, compressed, {
    contentType: 'image/jpeg',
    cacheControl: 'public,max-age=31536000,immutable',
  });

  const storedUrl = await getDownloadURL(r);
  return { url: storedUrl, path, size: compressed.size };
}

/**
 * Download a poster from an external URL (e.g. TMDB), compress and upload to Storage.
 * Returns { url, path } just like uploadPoster.
 */
export async function uploadPosterFromUrl({ url, titleIdOrTemp, uid }) {
  if (!url) throw new Error("URL poster mancante");
  if (!titleIdOrTemp) throw new Error("titleIdOrTemp mancante");
  if (!uid) throw new Error("UID mancante");

  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Fetch poster fallita (${res.status})`);
  const blob = await res.blob();

  const tmpFile = new File([blob], 'poster_tmdb.jpg', {
    type: blob.type || 'image/jpeg',
    lastModified: Date.now(),
  });

  return uploadPoster({ file: tmpFile, titleIdOrTemp, uid });
}

/**
 * Upload a poster image (ridotta) and return its download URL.
 */
export async function uploadPoster({ file, titleIdOrTemp, uid }){
  if (!file) throw new Error(i18nT("Nessun file selezionato."));

  // 1) comprimi SOLO se sopra una soglia (così non ricomprimi file già ok)
  let fileToUpload = file;

  // Soglia: 350KB (puoi alzare/abbassare)
  const THRESHOLD = 350 * 1024;

  if (file.size > THRESHOLD) {
    // primo tentativo
    fileToUpload = await compressImageFile(file, {
      maxWidth: 900,
      maxHeight: 1350,
      quality: 0.82,
      mimeType: "image/jpeg",
    });

    // se ancora troppo grande, secondo tentativo più aggressivo
    const HARD_CAP = 600 * 1024; // 600KB
    if (fileToUpload.size > HARD_CAP) {
      fileToUpload = await compressImageFile(file, {
        maxWidth: 850,
        maxHeight: 1275,
        quality: 0.76,
        mimeType: "image/jpeg",
      });
    }
  }

  // 2) upload
  const safeName = String(fileToUpload.name || "poster").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `posters/${uid}/${titleIdOrTemp}/${Date.now()}_${safeName}`;

  const r = ref(storage, path);
  await uploadBytes(r, fileToUpload, { contentType: fileToUpload.type || "image/jpeg" });

  const url = await getDownloadURL(r);
  return { url, path };
}

/**
 * Upload photo allegata a un voto/recensione.
 * Path: posters/{uid}/ratings/{titleId}/{timestamp}_{filename}
 */
export async function uploadRatingPhoto({ file, uid, titleId } = {}) {
  if (!file) throw new Error(i18nT("Nessun file selezionato."));
  if (!uid) throw new Error("UID mancante.");
  if (!titleId) throw new Error("titleId mancante.");
  if (!String(file.type || "").startsWith("image/")) throw new Error(i18nT("File non supportato."));

  const MAX_RAW_SIZE = 8 * 1024 * 1024;
  if (Number(file.size || 0) > MAX_RAW_SIZE) {
    throw new Error("Immagine troppo grande (max 8MB).");
  }

  const compressed = await compressImageFile(file, {
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 0.84,
    mimeType: "image/jpeg",
  });

  const safeName = String(compressed.name || "rating_photo.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `posters/${uid}/ratings/${titleId}/${Date.now()}_${safeName}`;

  const r = ref(storage, path);
  await uploadBytes(r, compressed, { contentType: "image/jpeg" });

  const url = await getDownloadURL(r);
  return { url, path };
}

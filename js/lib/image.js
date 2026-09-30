// Shrinks a photo before upload: phone cameras produce 3-8 MB files, which are slow on mobile
// data and larger than the 5 MB storage limit. Falls back to the original file if the browser
// can't decode it (for example HEIC outside Safari).
const MAX_SIDE = 1600;
const MAX_BYTES = 5 * 1024 * 1024;

export function isImage(file) {
  return !!file && /^image\//.test(file.type || '');
}

export async function prepareImage(file) {
  if (!isImage(file)) throw Object.assign(new Error('not an image'), { userMessage: 'Please choose a photo (JPG, PNG or WebP).' });
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob && blob.size > 0 && blob.size <= MAX_BYTES) return blob;
  } catch { /* use the original below */ }
  if (file.size > MAX_BYTES) throw Object.assign(new Error('too big'), { userMessage: 'That photo is too large. Please choose one under 5 MB.' });
  return file;
}

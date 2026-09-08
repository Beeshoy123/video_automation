const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { runFFmpeg } = require('./ffmpeg');

const MEDIA_ROOT = path.resolve(__dirname, '..', 'data', 'media');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function sanitizeName(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop().trim();
  const extension = path.extname(name).toLowerCase();
  if (!name || name.length > 255 || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw Object.assign(new Error('Invalid media filename'), { status: 400 });
  }
  if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
    throw Object.assign(new Error('Unsupported media format'), { status: 400 });
  }
  return name;
}

function resolveInsideRoot(name) {
  const resolved = path.resolve(MEDIA_ROOT, path.basename(name));
  if (!resolved.startsWith(`${MEDIA_ROOT}${path.sep}`)) throw Object.assign(new Error('Media path is not allowed'), { status: 400 });
  return resolved;
}

async function ensureRoot() { await fs.mkdir(MEDIA_ROOT, { recursive: true }); }

async function validateMedia(filePath, extension) {
  try {
    if (IMAGE_EXTENSIONS.has(extension)) {
      await sharp(filePath).metadata();
      return;
    }
    await runFFmpeg(['-nostdin', '-v', 'error', '-xerror', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-']);
  } catch (_error) {
    throw Object.assign(new Error('Media file is invalid or cannot be decoded'), { status: 400 });
  }
}

async function listAssets() {
  await ensureRoot();
  const entries = await fs.readdir(MEDIA_ROOT, { withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name).filter(name => {
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
  }).sort((left, right) => left.localeCompare(right));
}

async function resolveAssets(names = []) {
  const assets = [];
  for (const name of Array.isArray(names) ? names.slice(0, 20) : []) {
    const safeName = sanitizeName(name);
    const filePath = resolveInsideRoot(safeName);
    await fs.access(filePath);
    assets.push(filePath);
  }
  return assets;
}

async function saveAsset(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw Object.assign(new Error('Media upload is empty'), { status: 400 });
  const originalName = sanitizeName(filename);
  const extension = path.extname(originalName).toLowerCase();
  const limit = IMAGE_EXTENSIONS.has(extension) ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (buffer.length > limit) throw Object.assign(new Error(`Media file exceeds the ${limit / 1024 / 1024} MB limit`), { status: 413 });
  await ensureRoot();
  const storedName = `${crypto.randomUUID()}${extension}`;
  const temporaryPath = resolveInsideRoot(`.media-upload-${crypto.randomUUID()}${extension}`);
  const targetPath = resolveInsideRoot(storedName);
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: 'wx' });
    await validateMedia(temporaryPath, extension);
    await fs.rename(temporaryPath, targetPath);
    return { name: storedName, originalName, kind: IMAGE_EXTENSIONS.has(extension) ? 'image' : 'video', bytes: buffer.length };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

module.exports = { listAssets, resolveAssets, saveAsset, MEDIA_ROOT };

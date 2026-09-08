const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { runFFmpeg } = require('./ffmpeg');

const MUSIC_ROOT = path.resolve(__dirname, '..', 'data', 'music');
const MAX_BYTES = 30 * 1024 * 1024;
const EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;

function sanitizeName(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop().trim();
  if (!name || name.length > 255 || name === '.' || name === '..' || INVALID_NAME.test(name)) {
    throw Object.assign(new Error('Invalid music filename'), { status: 400 });
  }
  if (!EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw Object.assign(new Error('Unsupported music format'), { status: 400 });
  }
  return name;
}

function resolveInsideRoot(name) {
  const resolved = path.resolve(MUSIC_ROOT, path.basename(name));
  if (!resolved.startsWith(`${MUSIC_ROOT}${path.sep}`)) {
    throw Object.assign(new Error('Music path is not allowed'), { status: 400 });
  }
  return resolved;
}

async function ensureRoot() {
  await fs.mkdir(MUSIC_ROOT, { recursive: true });
}

async function validateAudio(filePath) {
  try {
    await runFFmpeg(['-nostdin', '-v', 'error', '-xerror', '-i', filePath, '-map', '0:a:0', '-f', 'null', '-']);
  } catch (_error) {
    throw Object.assign(new Error('Music file must contain a decodable audio stream'), { status: 400 });
  }
}

async function listTracks() {
  await ensureRoot();
  const entries = await fs.readdir(MUSIC_ROOT, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function saveTrack(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('Music upload is empty'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('Music file exceeds the 30 MB limit'), { status: 413 });
  }
  const originalName = sanitizeName(filename);
  await ensureRoot();
  const extension = path.extname(originalName).toLowerCase();
  const storedName = `${crypto.randomUUID()}${extension}`;
  const temporaryPath = resolveInsideRoot(`.music-upload-${crypto.randomUUID()}${extension}`);
  const targetPath = resolveInsideRoot(storedName);
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: 'wx' });
    await validateAudio(temporaryPath);
    await fs.rename(temporaryPath, targetPath);
    return { name: storedName, originalName, bytes: buffer.length };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

module.exports = { listTracks, saveTrack, MUSIC_ROOT, MAX_BYTES };

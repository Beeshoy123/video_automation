const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class StockMediaCache {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.searchTtlMs = Number(options.searchTtlMs || 24 * 60 * 60 * 1000);
  }

  key(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  async readSearch(provider, query, params = {}) {
    const filePath = path.join(this.rootDir, 'search', `${this.key({ provider, query, params })}.json`);
    const cached = await fs.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
    if (!cached || Date.now() - Number(cached.fetchedAt || 0) > this.searchTtlMs) return null;
    return cached.results || [];
  }

  async writeSearch(provider, query, params, results) {
    const directory = path.join(this.rootDir, 'search');
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${this.key({ provider, query, params })}.json`);
    await fs.writeFile(filePath, JSON.stringify({ provider, query, params, fetchedAt: Date.now(), results }, null, 2), 'utf8');
  }

  async materialize(provider, sourceUrl, extension = '.mp4') {
    const directory = path.join(this.rootDir, 'downloads');
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${this.key({ provider, sourceUrl })}${extension}`);
    const exists = await fs.stat(filePath).catch(() => null);
    return { filePath, hit: Boolean(exists?.isFile() && exists.size > 0) };
  }

  async checksum(filePath) {
    const digest = crypto.createHash('sha256');
    const buffer = await fs.readFile(filePath);
    digest.update(buffer);
    return digest.digest('hex');
  }
}

module.exports = { StockMediaCache };

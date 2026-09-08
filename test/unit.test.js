const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TaskManager } = require('../utils/task-manager');
const { buildConfig, migrateConfig } = require('../utils/config-schema');
const { VoiceProviderRegistry } = require('../utils/voice-providers');
const { CaptionService } = require('../utils/caption-service');

test('TaskManager runs jobs in concurrency order', async () => {
  const manager = new TaskManager({ maxConcurrent: 1, maxQueued: 2 });
  const order = [];
  const first = manager.submit('first', async () => { order.push('first'); });
  const second = manager.submit('second', async () => { order.push('second'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(manager.activeCount, 0);
  assert.equal(manager.queuedCount, 0);
});

test('TaskManager rejects a full queue', () => {
  const manager = new TaskManager({ maxConcurrent: 1, maxQueued: 0 });
  assert.throws(() => manager.submit('blocked', async () => {}), /queue is full/);
});

test('configuration migration upgrades v1 and excludes secrets', () => {
  const migrated = migrateConfig({ schemaVersion: 1, profile: { channel_name: 'Demo' }, settings: { video_provider: 'slideshow' } });
  const exported = buildConfig(migrated.profile, { ...migrated.settings, api_key: 'secret' });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.providerProfiles[0].id, 'slideshow');
  assert.equal(Object.hasOwn(exported.settings, 'api_key'), false);
});

test('voice registry selects the first available automatic provider', () => {
  const registry = new VoiceProviderRegistry({ available: { openai: true, gemini: false, elevenlabs: false } });
  assert.equal(registry.select('auto').id, 'openai');
  assert.equal(registry.select('gemini'), null);
});

test('CaptionService uses script fallback by default', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-'));
  const outputPath = path.join(directory, 'captions.srt');
  const service = new CaptionService({ mode: 'script' });
  const result = await service.generate({ outputPath, fallback: async () => '1\n00:00:00,000 --> 00:00:01,000\nHello\n' });
  assert.equal(result.method, 'script_timed');
  assert.match(await fs.readFile(outputPath, 'utf8'), /Hello/);
});

test('CaptionService falls back when speech transcription fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-'));
  const outputPath = path.join(directory, 'captions.srt');
  const service = new CaptionService({ mode: 'openai', transcriber: async () => { throw new Error('provider unavailable'); }, logger: { warn() {} } });
  const result = await service.generate({ audioPath: 'audio.mp3', outputPath, fallback: async () => '1\n00:00:00,000 --> 00:00:01,000\nFallback\n' });
  assert.equal(result.method, 'script_timed');
  assert.match(await fs.readFile(outputPath, 'utf8'), /Fallback/);
});

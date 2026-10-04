const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TaskManager } = require('../utils/task-manager');
const { buildConfig, migrateConfig } = require('../utils/config-schema');
const { VoiceProviderRegistry } = require('../utils/voice-providers');
const { CaptionService } = require('../utils/caption-service');
const { FacelessStockEngine } = require('../utils/faceless-stock-engine');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { MediaGenerationService } = require('../utils/media-generation-service');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { AITextService } = require('../utils/ai-text-service');
const { PlatformExportService } = require('../utils/platform-export-service');
const { checkFFmpeg, getMediaDuration, runFFmpeg } = require('../utils/ffmpeg');
const sharp = require('sharp');

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

test('ScriptWriterAgent fails loudly when no AI provider is configured', async () => {
  const agent = new ScriptWriterAgent({ saveScript: async () => {} }, {});
  const strategy = {
    topic: 'best budget desk setups',
    contentType: 'List',
    angle: 'simple affordable steps',
    targetAudience: 'remote workers',
    keywords: ['desk', 'workspace', 'budget'],
    requestedLength: '6-8 minutes'
  };

  await assert.rejects(
    () => agent.generateScript(strategy),
    /No AI text provider configured for script generation/
  );
});

test('AITextService retries without unsupported temperature and token parameters', async () => {
  const service = new AITextService();
  const calls = [];
  service.gemini = null;
  service.model = 'compatible-model';
  service.client = { chat: { completions: { create: async request => {
    calls.push(request);
    if (request.max_completion_tokens) {
      const error = new Error('max_completion_tokens is unsupported');
      error.status = 400;
      throw error;
    }
    if (request.temperature !== undefined) {
      const error = new Error('temperature only supports the default value');
      error.status = 400;
      throw error;
    }
    return { choices: [{ message: { content: 'usable response' } }] };
  } } } };

  assert.equal(await service.generateText('test prompt', { maxTokens: 64, temperature: 0.2 }), 'usable response');
  assert.deepEqual(calls.map(request => [Boolean(request.max_completion_tokens), Boolean(request.max_tokens), request.temperature]), [
    [true, false, 0.2],
    [false, true, 0.2],
    [false, true, undefined]
  ]);
});

test('AIVideoGenerator uses narration duration and falls back to script estimate', async () => {
  const generator = new AIVideoGenerator({}, {
    getMediaDuration: async audioPath => {
      if (audioPath === 'unreadable.mp3') throw new Error('probe failed');
      return 12;
    },
    logger: { warn() {}, info() {}, error() {} }
  });
  assert.equal(await generator.resolveSlideshowDuration({}, 'narration.mp3'), 12.5);
  const script = { hook: { text: 'one two three' } };
  assert.equal(await generator.resolveSlideshowDuration(script, 'unreadable.mp3'), generator.calculateScriptDuration(script));
});

test('AIVideoGenerator converts valid local images to browser-safe data URLs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-image-assets-'));
  const imagePath = path.join(directory, 'generated.png');
  const invalidPath = path.join(directory, 'invalid.png');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).png().toFile(imagePath);
  await fs.writeFile(invalidPath, 'not an image');
  const generator = new AIVideoGenerator({}, { logger: { warn() {}, info() {}, error() {} } });

  const imageAssets = await generator.filterImageAssets([imagePath, invalidPath]);
  assert.equal(imageAssets.length, 1);
  assert.match(imageAssets[0], /^data:image\/png;base64,/);
});

test('MediaGenerationService refuses silent slideshow fallback when a paid provider is selected', async () => {
  const service = new MediaGenerationService(
    { getAllSettings: async () => ({ video_provider: 'seedance', video_generation_mode: 'hybrid' }) },
    {},
    {
      registry: {
        select: () => null,
        list: () => []
      },
      logger: { warn() {}, info() {}, error() {} }
    }
  );

  await assert.rejects(
    () => service.generateClips({
      jobId: 'job-1',
      productionId: 'prod-1',
      script: { title: 'Desk setup guide' },
      visualAssets: [],
      outputDir: os.tmpdir()
    }),
    /Selected video provider "seedance" is not configured/
  );
});

test('FacelessStockEngine ranks portrait clips ahead of landscape results', () => {
  const engine = new FacelessStockEngine({}, { logger: { warn() {}, info() {}, error() {} } });
  const ranked = engine.rankVideoCandidates([
    { assetId: 'landscape', width: 1280, height: 720, duration: 8 },
    { assetId: 'portrait', width: 1080, height: 1920, duration: 8 },
    { assetId: 'portrait-long', width: 1080, height: 1920, duration: 12 }
  ]);

  assert.deepEqual(ranked.map(item => item.assetId), ['portrait-long', 'portrait', 'landscape']);
});

test('AIVideoGenerator slideshow HTML is minimal and avoids the old spammy text overlay', () => {
  const generator = new AIVideoGenerator({}, { logger: { warn() {}, info() {}, error() {} } });
  const html = generator.createSlideshowHTML({
    title: 'Desk setup guide',
    hook: { text: 'A better workspace starts with a smarter layout.' },
    mainContent: {
      sections: [{ title: 'Pick your desk', content: 'Pick a desk near a window and make sure it supports a clean, ergonomic setup.' }]
    }
  }, ['/tmp/image-1.png']);

  assert.match(html, /Desk setup guide/);
  assert.doesNotMatch(html, /Subscribe for More Stories/);
  assert.doesNotMatch(html, /Pick a desk near a window and make sure it supports a clean, ergonomic setup\./);
  assert.doesNotMatch(html, /make sure it supports a clean, ergonomic setup/i);
  assert.match(html, /Scene 1/);
});

test('AIVideoGenerator compresses slide text to a short key phrase instead of full script sentences', () => {
  const generator = new AIVideoGenerator({}, { logger: { warn() {}, info() {}, error() {} } });
  const html = generator.createSlideshowHTML({
    title: 'Desk setup guide',
    hook: { text: 'A better workspace starts with a smarter layout and a calmer workflow for focused work.' },
    mainContent: {
      sections: [{ title: 'Pick your desk', content: 'Pick a desk near a window and make sure it supports a clean, ergonomic setup.' }]
    }
  }, ['/tmp/image-1.png']);

  assert.match(html, /A better workspace starts/i);
  assert.doesNotMatch(html, /A better workspace starts with a smarter layout and a calmer workflow for focused work\./i);
  assert.doesNotMatch(html, /Pick a desk near a window and make sure it supports a clean, ergonomic setup\./i);
});

test('AIVideoGenerator chooses portrait-safe crop positioning for tall assets', () => {
  const generator = new AIVideoGenerator({}, { logger: { warn() {}, info() {}, error() {} } });
  const html = generator.createSlideshowHTML({
    title: 'Desk setup guide',
    hook: { text: 'A cleaner desk changes your energy.' },
    mainContent: {
      sections: [{ title: 'Pick your desk', content: 'Keep your desk clear and well-lit.' }]
    }
  }, ['/tmp/portrait-hero.jpg']);

  assert.match(html, /object-position: 50% 22%/i);
  assert.match(html, /transform: scale\(1\.08\)/i);
});

test('AIVideoGenerator adds subtle motion to slideshow stills for a more cinematic cadence', () => {
  const generator = new AIVideoGenerator({}, { logger: { warn() {}, info() {}, error() {} } });
  const html = generator.createSlideshowHTML({
    title: 'Desk setup guide',
    hook: { text: 'A cleaner desk changes your energy.' },
    mainContent: {
      sections: [{ title: 'Pick your desk', content: 'Keep your desk clear and well-lit.' }]
    }
  }, ['/tmp/portrait-hero.jpg']);

  assert.match(html, /gentlePan|animation: gentlePan/i);
});

test('PlatformExportService renders valid platform-specific vertical videos and metadata', async t => {
  if (!await checkFFmpeg()) {
    t.skip('FFmpeg is unavailable');
    return;
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-platform-export-'));
  const sourcePath = path.join(directory, 'source.mp4');
  const captionsPath = path.join(directory, 'source.srt');
  const outputDir = path.join(directory, 'exports');
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
  ]);
  const sourceDuration = await getMediaDuration(sourcePath);
  assert.ok(sourceDuration >= 0.9 && sourceDuration <= 1.5, `unexpected probed duration: ${sourceDuration}`);
  await fs.writeFile(captionsPath, '1\n00:00:00,000 --> 00:00:01,000\nTest caption\n', 'utf8');

  const service = new PlatformExportService({ width: 180, height: 320 });
  const files = await service.export('prod-test', {
    assets: { finalVideo: { path: sourcePath, aspectRatio: '16:9' }, captions: { path: captionsPath } },
    editorData: { title: 'A useful video' },
    seo: { description: 'A short description.', tags: ['video', 'tips'] }
  }, outputDir);

  for (const platform of ['tiktok', 'instagram-reels', 'youtube-shorts']) {
    const stats = await fs.stat(files[platform]);
    assert.ok(stats.size > 0, `${platform} output should contain a rendered MP4`);
    assert.ok((await fs.stat(files[`${platform}Captions`])).size > 0, `${platform} captions should be copied`);
  }
  const metadata = JSON.parse(await fs.readFile(files.metadata, 'utf8'));
  assert.equal(metadata.aspectRatio, '9:16');
  assert.deepEqual(
    ['tiktok', 'instagram-reels', 'youtube-shorts'].map(platform => metadata.platforms[platform].layout),
    ['crop', 'blur', 'stacked']
  );
  assert.match(metadata.platforms.tiktok.caption, /#video/);
  assert.match(metadata.platforms['instagram-reels'].caption, /A short description\./);
  assert.match(metadata.platforms['youtube-shorts'].title, /#Shorts/);
});

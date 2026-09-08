const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { AITextService } = require('./ai-text-service');
const { runFFmpeg } = require('./ffmpeg');
const { Logger } = require('./logger');
const { StockMediaCache } = require('./stock-media-cache');

const DEFAULT_SCENE_COUNT = 8;
const DEFAULT_VOICE = 'en-US-AvaNeural';

function cleanJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = value.indexOf('[');
  const end = value.lastIndexOf(']');
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

class FacelessStockEngine {
  constructor(credentials = {}, options = {}) {
    this.logger = options.logger || new Logger('FacelessStockEngine');
    const resolvedCredentials = credentials?.credentials || credentials;
    this.text = options.text || new AITextService(resolvedCredentials);
    this.tts = options.tts;
    this.pexelsKey = options.pexelsKey || resolvedCredentials.pexels?.apiKey || process.env.PEXELS_API_KEY;
    this.voice = options.voice || process.env.FACELESS_TTS_VOICE || DEFAULT_VOICE;
    this.http = options.http || axios;
    this.mediaCache = options.mediaCache || new StockMediaCache(path.resolve(__dirname, '..', 'data', 'media-cache'));
    this.sceneCount = Math.max(4, Math.min(10, Number(options.sceneCount || process.env.FACELESS_SCENE_COUNT || DEFAULT_SCENE_COUNT)));
  }

  async generate({ topic, script, outputDir }) {
    if (!this.tts || typeof this.tts.generateTTSAudio !== 'function') {
      throw new Error('Faceless stock engine requires the configured TTS service');
    }
    if (!this.pexelsKey) {
      throw new Error('PEXELS_API_KEY is required for the faceless stock engine');
    }

    const root = path.resolve(outputDir);
    const audioDir = path.join(root, 'audio');
    const videoDir = path.join(root, 'source-video');
    const sceneDir = path.join(root, 'scenes');
    await Promise.all([audioDir, videoDir, sceneDir].map(directory => fs.mkdir(directory, { recursive: true })));

    const scenes = await this.planScenes(topic, script);
    const rendered = [];
    const sourceAssets = [];
    let currentTime = 0;

    for (const [index, scene] of scenes.entries()) {
      const sceneId = index + 1;
      const audioPath = path.join(audioDir, `scene-${sceneId}.mp3`);
      await this.tts.generateTTSAudio(`${scene.text}`, audioPath);
      const duration = await this.audioDuration(audioPath);
      const clips = await this.downloadPair(scene, videoDir, sceneId);
      sourceAssets.push(...clips.map(item => ({ ...item, scene: sceneId })));
      const renderedPath = path.join(sceneDir, `scene-${sceneId}.mp4`);
      await this.renderScene(clips, audioPath, duration, renderedPath);
      rendered.push({ ...scene, id: sceneId, audioPath, duration, startSeconds: currentTime, path: renderedPath });
      currentTime += duration;
    }

    const finalPath = path.join(root, 'final-short.mp4');
    await this.concatScenes(rendered.map(scene => scene.path), finalPath);
    const captionsPath = path.join(root, 'captions.srt');
    await fs.writeFile(captionsPath, this.buildCaptions(rendered), 'utf8');

    return {
      finalPath,
      captionsPath,
      audioPath: rendered[0]?.audioPath || null,
      duration: currentTime,
      scenes: rendered,
      sourceAssets,
      provider: {
        actualProvider: 'faceless_stock',
        model: 'gemini+pexels+tts+ffmpeg',
        voice: this.voice,
        aspectRatio: '9:16'
      }
    };
  }

  async planScenes(topic, script = {}) {
    const prompt = `Return ONLY a JSON array of ${this.sceneCount} objects for a YouTube Short about "${String(topic || script.title || 'this topic').replace(/"/g, '\\"')}". Use this exact structure: {"text":"...","visual_1":"literal stock-video search terms","visual_2":"different literal stock-video search terms"}. The story must follow hook, context, mechanism, twist, conclusion. Keep each text field to one or two spoken sentences, factual and third-person. Do not include markdown.`;
    try {
      const response = await this.text.generateText(prompt, { maxTokens: 2400, temperature: 0.7 });
      const parsed = JSON.parse(cleanJson(response));
      if (Array.isArray(parsed) && parsed.length >= 4) {
        return parsed.slice(0, this.sceneCount).map((scene, index) => ({
          text: String(scene.text || '').trim(),
          visual_1: String(scene.visual_1 || scene.visual || 'abstract documentary footage').trim(),
          visual_2: String(scene.visual_2 || scene.visual_1 || scene.visual || 'abstract documentary footage').trim(),
          id: index + 1
        })).filter(scene => scene.text);
      }
    } catch (error) {
      this.logger.warn(`Faceless scene planning fell back to the existing script: ${error.message}`);
    }

    const text = this.flattenScript(script);
    const words = text.split(/\s+/).filter(Boolean);
    const size = Math.max(18, Math.ceil(words.length / this.sceneCount));
    return Array.from({ length: Math.min(this.sceneCount, Math.ceil(words.length / size)) }, (_, index) => ({
      id: index + 1,
      text: words.slice(index * size, (index + 1) * size).join(' '),
      visual_1: String(topic || script.title || 'documentary subject'),
      visual_2: 'cinematic documentary detail'
    })).filter(scene => scene.text);
  }

  flattenScript(script = {}) {
    const values = [script.hook?.text, script.title, script.introduction?.topicIntro, script.introduction?.valueProposition];
    for (const section of script.mainContent?.sections || []) {
      values.push(section.title);
      if (Array.isArray(section.content)) values.push(...section.content);
      else if (typeof section.content === 'string') values.push(section.content);
      for (const item of section.items || section.steps || []) values.push(item.title, item.description);
    }
    values.push(...(script.conclusion?.recap || []), script.conclusion?.finalThought);
    return values.filter(value => typeof value === 'string' && value.trim()).join(' ');
  }

  async searchVideo(query) {
    const params = { orientation: 'portrait', size: 'medium', per_page: 5 };
    const cached = await this.mediaCache.readSearch('pexels', query, params);
    if (cached?.length) return cached[0];
    const response = await this.http.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: this.pexelsKey },
      params: { query, ...params },
      timeout: 15000
    });
    const videos = (response.data?.videos || []).filter(video => video.duration >= 3);
    const selected = (videos.length ? videos : response.data?.videos || [])[0];
    if (!selected) return null;
    const files = [...(selected.video_files || [])].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    if (!files[0]?.link) return null;
    const result = {
      provider: 'pexels',
      assetId: String(selected.id || ''),
      sourcePage: selected.url || null,
      creator: selected.user?.name || null,
      query,
      duration: Number(selected.duration || 0),
      width: Number(files[0].width || 0),
      height: Number(files[0].height || 0),
      url: files[0].link
    };
    await this.mediaCache.writeSearch('pexels', query, params, [result]);
    return result;
  }

  async downloadPair(scene, videoDir, sceneId) {
    const queries = [scene.visual_1, scene.visual_2 || scene.visual_1];
    const paths = [];
    for (const [index, query] of queries.entries()) {
      let source = null;
      try { source = await this.searchVideo(query); } catch (error) { this.logger.warn(`Pexels search failed for scene ${sceneId}: ${error.message}`); }
      if (source?.url) {
        const target = path.join(videoDir, `scene-${sceneId}-${index + 1}.mp4`);
        const cachedDownload = await this.mediaCache.materialize('pexels', source.url);
        if (!cachedDownload.hit) {
          const response = await this.http.get(source.url, { responseType: 'arraybuffer', timeout: 30000 });
          await fs.writeFile(cachedDownload.filePath, response.data);
        }
        await fs.copyFile(cachedDownload.filePath, target);
        paths.push({
          path: target,
          query,
          provider: source.provider,
          assetId: source.assetId,
          sourcePage: source.sourcePage,
          creator: source.creator,
          duration: source.duration,
          width: source.width,
          height: source.height,
          cacheHit: cachedDownload.hit,
          checksum: await this.mediaCache.checksum(cachedDownload.filePath)
        });
      }
    }
    if (!paths.length) throw new Error(`Pexels returned no usable videos for scene ${sceneId}`);
    if (paths.length === 1) paths.push(paths[0]);
    return paths;
  }

  async audioDuration(audioPath) {
    const { stdout } = await require('./ffmpeg').runFFmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-i', audioPath]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 4;
  }

  async renderScene(clips, audioPath, duration, outputPath) {
    const half = Math.max(1, duration / 2);
    const filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=${half},setpts=PTS-STARTPTS[a];[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=${half},setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]`;
    await runFFmpeg([
      '-y', '-stream_loop', '-1', '-i', clips[0].path, '-stream_loop', '-1', '-i', clips[1].path, '-i', audioPath,
      '-filter_complex', filter, '-map', '[v]', '-map', '2:a:0', '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outputPath
    ]);
  }

  async concatScenes(paths, outputPath) {
    const listPath = `${outputPath}.txt`;
    await fs.writeFile(listPath, paths.map(item => `file '${item.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    try {
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
    } finally {
      await fs.unlink(listPath).catch(() => {});
    }
  }

  buildCaptions(scenes) {
    return scenes.map((scene, index) => `${index + 1}\n${formatSrtTime(scene.startSeconds)} --> ${formatSrtTime(scene.startSeconds + scene.duration)}\n${scene.text}\n`).join('\n');
  }
}

module.exports = { FacelessStockEngine, cleanJson, formatSrtTime };
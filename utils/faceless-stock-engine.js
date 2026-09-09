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
    this.avatarPath = options.avatarPath || process.env.FACELESS_AVATAR_PATH || null;
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
    const avatar = await this.resolveAvatar();
    const avatarIndex = avatar && scenes.length >= 4 ? this.chooseAvatarIndex(scenes.length, topic) : -1;
    const rendered = [];
    const sourceAssets = [];
    let currentTime = 0;

    for (const [index, scene] of scenes.entries()) {
      const sceneId = index + 1;
      const audioPath = path.join(audioDir, `scene-${sceneId}.mp3`);
      await this.generateNarrationWithRetry(scene.text, audioPath);
      await this.trimNarrationSilence(audioPath);
      await this.fitNarrationDuration(audioPath, 8);
      const duration = await this.audioDuration(audioPath);
      const clips = avatarIndex === index
        ? [{ path: avatar, provider: 'local-avatar', query: 'configured avatar' }, { path: avatar, provider: 'local-avatar', query: 'configured avatar' }]
        : await this.downloadPair(scene, videoDir, sceneId);
      sourceAssets.push(...clips.map(item => ({ ...item, scene: sceneId })));
      const renderedPath = path.join(sceneDir, `scene-${sceneId}.mp4`);
      await this.renderScene(clips, audioPath, duration, renderedPath);
      rendered.push({ ...scene, id: sceneId, audioPath, duration, startSeconds: currentTime, path: renderedPath });
      currentTime += duration;
    }

    const finalPath = path.join(root, 'final-short.mp4');
    await this.concatScenes(rendered.map(scene => scene.path), finalPath, rendered);
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
        aspectRatio: '9:16',
        avatarInjected: avatarIndex >= 0
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
    const results = await this.searchVideos(query);
    return results[0] || null;
  }

  async searchVideos(query, excludedAssetIds = []) {
    const params = { orientation: 'portrait', size: 'medium', per_page: 5 };
    const cached = await this.mediaCache.readSearch('pexels', query, params);
    if (cached?.length) {
      const available = cached.filter(item => !excludedAssetIds.includes(String(item.assetId)));
      if (available.length) return available;
    }
    const response = await this.http.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: this.pexelsKey },
      params: { query, ...params },
      timeout: 15000
    });
    const videos = (response.data?.videos || []).filter(video => video.duration >= 3);
    const results = (videos.length ? videos : response.data?.videos || [])
      .map(video => {
        const files = [...(video.video_files || [])].sort((a, b) => (b.width * b.height) - (a.width * a.height));
        if (!files[0]?.link) return null;
        return {
          provider: 'pexels',
          assetId: String(video.id || ''),
          sourcePage: video.url || null,
          creator: video.user?.name || null,
          query,
          duration: Number(video.duration || 0),
          width: Number(files[0].width || 0),
          height: Number(files[0].height || 0),
          url: files[0].link
        };
      })
      .filter(Boolean);
    if (!results.length) {
      const simplifiedQuery = String(query || '').trim().split(/\s+/).filter(Boolean).pop();
      if (simplifiedQuery && simplifiedQuery.toLowerCase() !== String(query || '').trim().toLowerCase()) {
        this.logger.info(`Retrying Pexels search with simplified query: ${simplifiedQuery}`);
        return this.searchVideos(simplifiedQuery, excludedAssetIds);
      }
    }
    await this.mediaCache.writeSearch('pexels', query, params, results);
    return results.filter(item => !excludedAssetIds.includes(String(item.assetId)));
  }

  async downloadPair(scene, videoDir, sceneId) {
    const queries = [scene.visual_1, scene.visual_2 || scene.visual_1];
    const paths = [];
    const selectedAssetIds = [];
    for (const [index, query] of queries.entries()) {
      let sources = [];
      try { sources = await this.searchVideos(query, selectedAssetIds); } catch (error) { this.logger.warn(`Pexels search failed for scene ${sceneId}: ${error.message}`); }
      const offset = sources.length ? (sceneId + index - 1) % sources.length : 0;
      const orderedSources = sources.length
        ? [...sources.slice(offset), ...sources.slice(0, offset)]
        : sources;
      for (const source of orderedSources) {
        try {
          const target = path.join(videoDir, `scene-${sceneId}-${index + 1}.mp4`);
          const cachedDownload = await this.mediaCache.materialize('pexels', source.url);
          if (!cachedDownload.hit) {
            const response = await this.http.get(source.url, { responseType: 'arraybuffer', timeout: 30000 });
            await fs.writeFile(cachedDownload.filePath, response.data);
          }
          await this.validateVideoClip(cachedDownload.filePath);
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
          selectedAssetIds.push(String(source.assetId));
          break;
        } catch (error) {
          this.logger.warn(`Pexels clip rejected for scene ${sceneId}: ${error.message}`);
        }
      }
    }
    if (!paths.length) throw new Error(`Pexels returned no usable videos for scene ${sceneId}`);
    if (paths.length === 1) paths.push(paths[0]);
    return paths;
  }

  async validateVideoClip(filePath) {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size < 1000) throw new Error('downloaded file is empty or too small');
    await runFFmpeg(['-v', 'error', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-']);
  }

  async audioDuration(audioPath) {
    const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';
    let output = '';
    try {
      const result = await runFFmpeg(['-hide_banner', '-i', audioPath, '-f', 'null', nullOutput]);
      output = `${result.stdout || ''}\n${result.stderr || ''}`;
    } catch (error) {
      output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    }
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const duration = match
      ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      : Number.NaN;
    return Number.isFinite(duration) && duration > 0 ? duration : 4;
  }

  async generateNarrationWithRetry(text, audioPath, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.tts.generateTTSAudio(String(text), audioPath);
      } catch (error) {
        lastError = error;
        this.logger.warn(`Narration failed for attempt ${attempt}/${retries}: ${error.message}`);
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 750 * attempt));
      }
    }
    throw lastError || new Error('Narration generation failed');
  }

  async resolveAvatar() {
    if (!this.avatarPath) return null;
    try {
      await this.validateVideoClip(this.avatarPath);
      return this.avatarPath;
    } catch (error) {
      this.logger.warn(`Configured faceless avatar was rejected: ${error.message}`);
      return null;
    }
  }

  chooseAvatarIndex(sceneCount, topic = '') {
    const middleCount = Math.max(1, sceneCount - 2);
    const seed = [...String(topic)].reduce((total, character) => total + character.charCodeAt(0), 0);
    return 1 + (seed % middleCount);
  }

  async trimNarrationSilence(audioPath) {
    const trimmedPath = audioPath.replace(/\.mp3$/i, '_trimmed.mp3');
    await runFFmpeg([
      '-y', '-i', audioPath,
      '-af', 'silenceremove=start_periods=1:start_duration=0.18:start_threshold=-45dB:stop_periods=1:stop_duration=0.32:stop_threshold=-45dB',
      '-c:a', 'libmp3lame', '-b:a', '160k', trimmedPath
    ]);
    await fs.rename(trimmedPath, audioPath);
    return audioPath;
  }

  async fitNarrationDuration(audioPath, maximumSeconds) {
    const duration = await this.audioDuration(audioPath);
    if (duration <= maximumSeconds) return audioPath;
    const tempo = Math.min(1.5, Math.max(1, duration / maximumSeconds));
    const filters = [];
    let remaining = tempo;
    while (remaining > 2) {
      filters.push('atempo=2');
      remaining /= 2;
    }
    filters.push(`atempo=${remaining.toFixed(3)}`);
    const fittedPath = audioPath.replace(/\.mp3$/i, '_fitted.mp3');
    await runFFmpeg([
      '-y', '-i', audioPath,
      '-af', filters.join(','),
      '-c:a', 'libmp3lame', '-b:a', '160k', fittedPath
    ]);
    await fs.rename(fittedPath, audioPath);
    return audioPath;
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

  async concatScenes(paths, outputPath, scenes = []) {
    if (paths.length <= 1) {
      await fs.copyFile(paths[0], outputPath);
      return;
    }

    const transition = 0.35;
    const transitionStyles = ['fade', 'slideleft', 'slideright', 'wipeleft', 'wiperight'];
    const durations = paths.map((_, index) => Math.max(1, Number(scenes[index]?.duration || 1)));
    const args = ['-y'];
    paths.forEach(scenePath => args.push('-i', scenePath));
    const filters = [];
    let videoLabel = '[0:v]';
    let audioLabel = '[0:a]';
    let elapsed = durations[0];

    for (let index = 1; index < paths.length; index++) {
      const duration = Math.min(transition, durations[index - 1] / 2, durations[index] / 2);
      const nextVideo = `[v${index}]`;
      const nextAudio = `[a${index}]`;
      const offset = Math.max(0, elapsed - duration).toFixed(3);
      const transitionStyle = transitionStyles[(index - 1) % transitionStyles.length];
      filters.push(`${videoLabel}[${index}:v]xfade=transition=${transitionStyle}:duration=${duration.toFixed(3)}:offset=${offset}${nextVideo}`);
      filters.push(`${audioLabel}[${index}:a]acrossfade=d=${duration.toFixed(3)}:curve1=tri:curve2=tri${nextAudio}`);
      videoLabel = nextVideo;
      audioLabel = nextAudio;
      elapsed += durations[index] - duration;
    }

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', videoLabel, '-map', audioLabel,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', outputPath
    );
    await runFFmpeg(args);
  }

  buildCaptions(scenes) {
    return scenes.map((scene, index) => `${index + 1}\n${formatSrtTime(scene.startSeconds)} --> ${formatSrtTime(scene.startSeconds + scene.duration)}\n${scene.text}\n`).join('\n');
  }
}

module.exports = { FacelessStockEngine, cleanJson, formatSrtTime };
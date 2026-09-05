const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');
const { AITextService } = require('./ai-text-service');
const { Logger } = require('./logger');

const STORY_TYPES = {
  general: 'A vivid story with a clear protagonist, setting, conflict, and resolution.',
  scary: 'Build unease gradually, use sensory detail, and end with a memorable reveal.',
  mystery: 'Introduce a question, reveal clues in sequence, and resolve the central mystery.',
  bedtime: 'Use gentle language, a cozy setting, a peaceful conflict, and a comforting lesson.',
  history: 'Use verifiable historical context, real figures only when supported, and distinguish legend from fact.',
  urban_legends: 'Describe the cultural setting and legend while making uncertainty explicit.',
  motivational: 'Show a relatable setback, a turning point, practical action, and earned progress.',
  fun_facts: 'Explain a surprising fact through a simple narrative and a clear real-world implication.',
  philosophy: 'Explore one accessible question through a concrete thought experiment and open-ended conclusion.'
};

const IMAGE_STYLES = ['cinematic', 'photorealistic', 'anime', 'comic-book', 'pixar-art'];

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
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(totalMs % 1000).padStart(3, '0')}`;
}

class NarrativeStoryEngine {
  constructor(credentials = {}, options = {}) {
    const resolvedCredentials = credentials?.credentials || credentials;
    this.logger = options.logger || new Logger('NarrativeStoryEngine');
    this.text = options.text || new AITextService(resolvedCredentials);
    this.visual = options.visual;
    this.tts = options.tts;
    this.sceneCount = Math.max(4, Math.min(14, Number(options.sceneCount || process.env.NARRATIVE_SCENE_COUNT || 8)));
    this.imageStyle = options.imageStyle || process.env.NARRATIVE_IMAGE_STYLE || 'cinematic';
  }

  async generate({ topic, script, outputDir, storyType = 'general', imageStyle = this.imageStyle }) {
    if (!this.visual || typeof this.visual.generateVisualAssets !== 'function') throw new Error('Narrative story engine requires an image generation service');
    if (!this.tts || typeof this.tts.generateTTSAudio !== 'function') throw new Error('Narrative story engine requires the configured TTS service');
    const root = path.resolve(outputDir);
    const audioDir = path.join(root, 'audio');
    const imageDir = path.join(root, 'images');
    const sceneDir = path.join(root, 'scenes');
    await Promise.all([audioDir, imageDir, sceneDir].map(directory => fs.mkdir(directory, { recursive: true })));

    const characters = await this.buildCharacterBible(topic, script, storyType);
    const storyboard = await this.buildStoryboard(topic, script, storyType, characters);
    const rendered = [];
    let currentTime = 0;

    for (const [index, scene] of storyboard.entries()) {
      const sceneNumber = index + 1;
      const audioPath = path.join(audioDir, `scene-${sceneNumber}.mp3`);
      const imagePath = path.join(imageDir, `scene-${sceneNumber}.png`);
      await this.tts.generateTTSAudio(scene.subtitles, audioPath);
      this.assertRealAsset(audioPath, 'narration');
      const imageResults = await this.visual.generateVisualAssets(this.imagePrompt(scene, characters, imageStyle), imageStyle, 1);
      const generatedImage = imageResults?.[0];
      if (!generatedImage || path.extname(generatedImage).toLowerCase() === '.info') throw new Error(`Image generation did not return a real asset for scene ${sceneNumber}`);
      await fs.copyFile(generatedImage, imagePath);
      const duration = await this.audioDuration(audioPath);
      const renderedPath = path.join(sceneDir, `scene-${sceneNumber}.mp4`);
      await this.renderScene(imagePath, audioPath, duration, renderedPath);
      rendered.push({ ...scene, id: sceneNumber, imagePath, audioPath, duration, startSeconds: currentTime, path: renderedPath });
      currentTime += duration;
    }

    const finalPath = path.join(root, 'final-story.mp4');
    await this.concatScenes(rendered.map(scene => scene.path), finalPath);
    const captionsPath = path.join(root, 'captions.srt');
    await fs.writeFile(captionsPath, this.buildCaptions(rendered), 'utf8');
    return {
      finalPath,
      captionsPath,
      audioPath: rendered[0]?.audioPath || null,
      duration: currentTime,
      scenes: rendered,
      characters,
      provider: { actualProvider: 'narrative_story', model: `image+${imageStyle}+tts+ffmpeg`, aspectRatio: '9:16', storyType }
    };
  }

  async buildCharacterBible(topic, script = {}, storyType = 'general') {
    const prompt = `Return only a JSON array of character objects for a ${storyType} story about "${String(topic || script.title || 'this story').replace(/"/g, '\\"')}". Use at most three characters. Each object must contain name, age, appearance, and consistent_traits. Do not invent real people.`;
    try {
      const response = await this.text.generateText(prompt, { maxTokens: 700, temperature: 0.7 });
      const parsed = JSON.parse(cleanJson(response));
      return Array.isArray(parsed) ? parsed.slice(0, 3).filter(character => character.name && character.appearance) : [];
    } catch (error) {
      this.logger.warn(`Character bible unavailable; continuing without named characters: ${error.message}`);
      return [];
    }
  }

  async buildStoryboard(topic, script = {}, storyType = 'general', characters = []) {
    const guidance = STORY_TYPES[storyType] || STORY_TYPES.general;
    const prompt = `Return only a JSON array of ${this.sceneCount} storyboard objects for a vertical YouTube story about "${String(topic || script.title || 'this story').replace(/"/g, '\\"')}". Story type: ${storyType}. Guidance: ${guidance} Each object must contain description, subtitles, and transition_type. Subtitles must be narration-ready and the scenes must follow beginning, development, turning point, and ending. Character continuity: ${JSON.stringify(characters)}. Source script: ${String(script.fullScript || script.title || '').slice(0, 7000)}`;
    try {
      const response = await this.text.generateText(prompt, { maxTokens: 2600, temperature: 0.8 });
      const parsed = JSON.parse(cleanJson(response));
      if (Array.isArray(parsed) && parsed.length >= 4) return parsed.slice(0, this.sceneCount).map(scene => ({
        description: String(scene.description || '').trim(),
        subtitles: String(scene.subtitles || '').trim(),
        transition_type: ['zoom-in', 'zoom-out', 'cut'].includes(scene.transition_type) ? scene.transition_type : 'cut'
      })).filter(scene => scene.description && scene.subtitles);
    } catch (error) {
      this.logger.warn(`Storyboard planning fell back to the existing script: ${error.message}`);
    }
    const text = this.flattenScript(script);
    const words = text.split(/\s+/).filter(Boolean);
    const size = Math.max(18, Math.ceil(words.length / this.sceneCount));
    return Array.from({ length: Math.min(this.sceneCount, Math.ceil(words.length / size)) }, (_, index) => {
      const subtitles = words.slice(index * size, (index + 1) * size).join(' ');
      return { description: `${subtitles}. ${this.imageStyle} narrative scene`, subtitles, transition_type: index % 2 ? 'zoom-in' : 'zoom-out' };
    }).filter(scene => scene.subtitles);
  }

  flattenScript(script = {}) {
    const values = [script.title, script.hook?.text, script.introduction?.topicIntro, script.introduction?.valueProposition];
    for (const section of script.mainContent?.sections || []) {
      values.push(section.title, Array.isArray(section.content) ? section.content.join(' ') : section.content);
      for (const item of section.items || section.steps || []) values.push(item.title, item.description);
    }
    values.push(...(script.conclusion?.recap || []), script.conclusion?.finalThought);
    return values.filter(value => typeof value === 'string' && value.trim()).join(' ');
  }

  imagePrompt(scene, characters, imageStyle = this.imageStyle) {
    const continuity = characters.map(character => `${character.name}: ${character.appearance}; ${character.consistent_traits || ''}`).join(' | ');
    return `${scene.description}. Visual style: ${imageStyle}. Vertical cinematic composition, strong focal subject, no text, no watermark. ${continuity}`.trim();
  }

  assertRealAsset(filePath, label) {
    if (!filePath || path.extname(filePath).toLowerCase() === '.info') throw new Error(`${label} generation returned a simulated asset`);
  }

  async audioDuration(audioPath) {
    const { stdout } = await runFFmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-i', audioPath]);
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 4;
  }

  async renderScene(imagePath, audioPath, duration, outputPath) {
    await runFFmpeg(['-y', '-loop', '1', '-i', imagePath, '-i', audioPath, '-t', String(duration), '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p', '-r', '30', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', outputPath]);
  }

  async concatScenes(paths, outputPath) {
    const listPath = `${outputPath}.txt`;
    await fs.writeFile(listPath, paths.map(item => `file '${item.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    try { await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath]); }
    finally { await fs.unlink(listPath).catch(() => {}); }
  }

  buildCaptions(scenes) {
    return scenes.map((scene, index) => `${index + 1}\n${formatSrtTime(scene.startSeconds)} --> ${formatSrtTime(scene.startSeconds + scene.duration)}\n${scene.subtitles}\n`).join('\n');
  }
}

module.exports = { NarrativeStoryEngine, STORY_TYPES, IMAGE_STYLES, cleanJson, formatSrtTime };
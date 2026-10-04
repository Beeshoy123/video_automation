const OpenAI = require('openai');
const Replicate = require('replicate');
const { createReadStream } = require('fs');
const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');
const { VoiceProviderRegistry } = require('./voice-providers');

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const openrouterKey = resolvedCredentials.openrouter?.apiKey || process.env.OPENROUTER_API_KEY;
    this.openrouterImageModel = resolvedCredentials.openrouter?.imageModel || process.env.OPENROUTER_IMAGE_MODEL;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }

    if (openrouterKey && this.openrouterImageModel) {
      this.openrouterImages = new OpenAI({
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1'
      });
      this.logger.info(`OpenRouter image service initialized (model: ${this.openrouterImageModel})`);
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    this.geminiImageModel = resolvedCredentials.gemini?.imageModel || process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info(`Gemini media service initialized (image model: ${this.geminiImageModel})`);
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.voiceProviders = new VoiceProviderRegistry({ available: {
      elevenlabs: Boolean(this.elevenLabsApiKey && this.elevenLabsVoiceId),
      openai: Boolean(this.openai),
      gemini: Boolean(this.gemini)
    } });
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath, options = {}) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;

    try {
      let generatedPath;
      const voiceName = String(options.voiceName || '').trim();
      const registry = new VoiceProviderRegistry({ available: {
        elevenlabs: Boolean(this.elevenLabsApiKey && (voiceName || this.elevenLabsVoiceId)),
        openai: Boolean(this.openai),
        gemini: Boolean(this.gemini)
      } });
      const selected = registry.select(options.provider || 'auto');
      if (selected?.id === 'elevenlabs') {
        provider = selected.id;
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath, voiceName || this.elevenLabsVoiceId);
      } else if (selected?.id === 'openai') {
        provider = selected.id;
        model = selected.model;
        generatedPath = await this.generateOpenAITTS(text, outputPath, voiceName || 'coral');
      } else if (selected?.id === 'gemini') {
        provider = selected.id;
        model = selected.model;
        generatedPath = await this.generateGeminiTTS(text, outputPath, voiceName || process.env.GEMINI_TTS_VOICE || 'Kore');
      } else {
        generatedPath = await this.simulateTTSGeneration(text, outputPath);
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      if (usable) generatedPath = await this.normalizeNarrationAudio(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      return generatedPath;
    } catch (error) {
      if (provider === 'openai' && this.gemini) {
        try {
          this.logger.warn(`OpenAI narration failed; falling back to Gemini: ${error.message}`);
          const fallbackPath = await this.generateGeminiTTS(text, outputPath, options.voiceName || process.env.GEMINI_TTS_VOICE || 'Kore');
          const usable = await this.isUsableAudioFile(fallbackPath);
          const normalizedPath = usable ? await this.normalizeNarrationAudio(fallbackPath) : fallbackPath;
          this.lastNarrationResult = {
            status: usable ? 'ready' : 'unavailable',
            path: normalizedPath,
            provider: 'gemini',
            model: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview',
            externalTaskId: null,
            generatedAt: new Date().toISOString(),
            simulated: !usable,
            fallbackFrom: 'openai',
            error: error.message,
            cost: { provider: 'gemini', amount: null, currency: null, invoiceRequired: true }
          };
          return normalizedPath;
        } catch (fallbackError) {
          this.logger.error(`Gemini narration fallback failed: ${fallbackError.message}`);
        }
      }
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  listVoiceProviders() {
    return this.voiceProviders.list();
  }

  async transcribeAudioToSrt(audioPath) {
    if (!this.openai) throw new Error('OpenAI is not configured for speech transcription');
    const response = await this.openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
      response_format: 'srt'
    });
    return typeof response === 'string' ? response : response.text || '';
  }

  async normalizeNarrationAudio(audioPath) {
    const normalizedPath = audioPath.replace(/\.[^.]+$/, '_normalized.mp3');
    await runFFmpeg([
      '-y', '-i', audioPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
      '-c:a', 'libmp3lame', '-b:a', '160k', normalizedPath
    ]);
    await fs.rename(normalizedPath, audioPath);
    this.logger.info('Narration loudness normalized');
    return audioPath;
  }

  async generateElevenLabsTTS(text, outputPath, voiceId = this.elevenLabsVoiceId) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath, voice = 'coral') {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath, voiceName = process.env.GEMINI_TTS_VOICE || 'Kore') {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
              prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !this.openrouterImages && !this.gemini) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      throw new Error(`Real visual generation failed: ${error.message}. Fix the configured image provider before continuing.`);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    if (this.openai) {
      return await this.generateOpenAIImage(prompt, imagePath);
    }

    if (this.openrouterImages) {
      return await this.generateOpenRouterImage(prompt, imagePath);
    }

    if (this.gemini) {
      return await this.generateGeminiImage(prompt, imagePath);
    }

    throw new Error('No image generation provider configured');
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: "gpt-image-2",
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateOpenRouterImage(prompt, imagePath) {
    const response = await this.openrouterImages.chat.completions.create({
      model: this.openrouterImageModel,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['text', 'image']
    });
    const message = response.choices?.[0]?.message;
    const image = message?.images?.find(item => item.image_url?.url)?.image_url?.url
      || (Array.isArray(message?.content)
        ? message.content.find(item => item.type === 'image_url')?.image_url?.url
        : null);
    if (!image) {
      throw new Error(`OpenRouter image model ${this.openrouterImageModel} returned no image data`);
    }
    if (image.startsWith('data:')) {
      const match = image.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) throw new Error('OpenRouter returned an invalid image data URL');
      await fs.writeFile(imagePath, Buffer.from(match[1], 'base64'));
    } else {
      await this.downloadImage(image, imagePath);
    }
    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = this.geminiImageModel;

    let response;
    try {
      response = await this.gemini.models.generateContent({
        model,
        contents: prompt
      });
    } catch (error) {
      const message = error?.message || String(error);
      throw new Error(`Gemini image request failed for model ${model}: ${message}`);
    }

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'));
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from assets...');
    this.lastVideoResult = null;
    try {
      if (this.mediaGeneration && options.productionId) {
        const generated = await this.mediaGeneration.generateClips({
          jobId: options.jobId || null,
          productionId: options.productionId,
          script,
          visualAssets,
          outputDir: path.dirname(outputPath),
          overrides: options.sceneDuration ? { clipDuration: Math.max(3, Math.min(30, Number(options.sceneDuration))) } : {}
        });
        if (generated.clips.length) {
          const produced = await this.generateHybridVideo(
            generated.clips,
            visualAssets,
            audioPath,
            outputPath,
            options.estimatedDuration || this.calculateScriptDuration(script),
            options
          );
          this.lastVideoResult = {
            requestedProvider: generated.requestedProvider,
            actualProvider: generated.actualProvider,
            model: generated.model,
            mode: generated.settings.mode,
            generatedSeconds: generated.clips.reduce((total, clip) => total + clip.duration, 0),
            tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
            scenes: generated.clips.map(clip => ({
              index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
              path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model
            }))
          };
          return produced;
        }
      }

      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options);
      this.lastVideoResult = { requestedProvider: 'slideshow', actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: [] };
      return produced;
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      const settings = this.mediaGeneration ? await this.mediaGeneration.settings().catch(() => ({ provider: 'slideshow', mode: 'hybrid' })) : { provider: 'slideshow', mode: 'hybrid' };
      const allowSlideshowFallback = settings.provider === 'slideshow' || settings.mode === 'slideshow';

      if (!allowSlideshowFallback) {
        this.logger.error(`Video provider generation failed for selected provider "${settings.provider}": ${reason}`, error);
        throw new Error(`Selected video provider "${settings.provider}" failed and slideshow fallback is disabled. Configure the provider or switch VIDEO_PROVIDER=slideshow. Original error: ${reason}`);
      }

      // The Logger's console line only shows the message string, so put the real
      // reason inline. Previously the stack alone went to the file transport and
      // the console printed "Video generation failed:" with no detail.
      this.logger.error(`Video provider generation failed; using the local slideshow: ${reason}`, error);
      try {
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options);
        this.lastVideoResult = {
          requestedProvider: this.lastVideoResult?.requestedProvider || 'configured-provider',
          actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'fallback', generatedSeconds: 0,
          fallbackReason: reason, tasks: [], scenes: []
        };
        return produced;
      } catch (fallbackError) {
        this.logger.error(`Local slideshow fallback failed: ${fallbackError.message}`, fallbackError);
        const produced = await this.generateEmergencyVideo(script, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: 'configured-provider', actualProvider: 'slideshow_fallback', model: 'local-ffmpeg',
          mode: 'fallback', generatedSeconds: this.calculateScriptDuration(script),
          fallbackReason: `${reason}; ${fallbackError.message}`, tasks: [], scenes: []
        };
        return produced;
      }
    }
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration, options = {}) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath, options);
    await this.addAudioToVideo(visualPath, audioPath, outputPath, { loopVideo: true });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  async renderMediaTimeline(segments, outputPath, options = {}) {
    const args = ['-y'];
    for (const segment of segments) {
      if (segment.type === 'image') args.push('-loop', '1', '-t', Number(segment.duration).toFixed(2), '-framerate', '30', '-i', segment.path);
      else args.push('-stream_loop', '-1', '-i', segment.path);
    }
    const filters = segments.map((segment, index) => {
      const duration = Number(segment.duration);
      const fade = options.transitionMode === 'cut' ? 0 : Math.min(0.35, Math.max(0.1, duration / 4));
      const fadeStart = Math.max(0, duration - fade);
      const fit = options.fitMode === 'contain'
        ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
        : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080';
      const fades = fade ? `,fade=t=in:st=0:d=${fade.toFixed(2)},fade=t=out:st=${fadeStart.toFixed(2)}:d=${fade.toFixed(2)}` : '';
      return `[${index}:v]${fit},fps=30,format=yuv420p,trim=duration=${duration.toFixed(2)},setpts=PTS-STARTPTS${fades}[v${index}]`;
    });
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    await runFFmpeg(args);
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = this.calculateScriptDuration(script);
      await this.renderSlidesToVideo(stills, duration, videoPath, options);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async generateEmergencyVideo(script, audioPath, outputPath) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const duration = Math.max(5, this.calculateScriptDuration(script));
    const hasAudio = await this.isUsableAudioFile(audioPath);
    const args = [
      '-y', '-f', 'lavfi', '-i', `color=c=0x172033:s=1920x1080:r=30:d=${duration}`
    ];
    if (hasAudio) args.push('-i', audioPath);
    args.push('-map', '0:v');
    if (hasAudio) args.push('-map', '1:a', '-c:a', 'aac', '-shortest');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);
    await runFFmpeg(args);
    return outputPath;
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath, options = {}) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const perSlide = Math.max(2, totalDuration / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    if (options.transitionMode === 'cut') {
      args.push('-filter_complex', `${stills.map((_, index) => `[${index}:v]`).join('')}concat=n=${stills.length}:v=1:a=0[vfinal]`, '-map', '[vfinal]', '-c:v', 'libx264', '-r', '30', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        await fs.access(asset);
        images.push(pathToFileURL(asset).href);
      } catch (error) {
        // Skip missing files
      }
    }

    return images;
  }

  cleanSlideText(text, maxLength = 90) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([,:;.!?])\s*/g, '$1 ')
      .trim()
      .slice(0, maxLength)
      .trim();
  }

  compressSlideText(text, maxWords = 7, maxLength = 90) {
    const normalized = this.cleanSlideText(text || '', maxLength * 2)
      .replace(/\s*([,:;.!?])\s*/g, '$1 ')
      .trim();

    if (!normalized) return '';

    const words = normalized.split(/\s+/);
    if (words.length <= maxWords) {
      return normalized;
    }

    const compressed = words.slice(0, maxWords).join(' ').replace(/[,:;.!?]+$/, '');
    return `${compressed}…`;
  }

  getVisualCropStyle(asset = '') {
    const normalized = String(asset).toLowerCase();

    if (/(portrait|vertical|tall|story|short)/.test(normalized)) {
      return 'object-position: 50% 22%; transform: scale(1.08);';
    }

    if (/(landscape|wide|banner|panorama)/.test(normalized)) {
      return 'object-position: 50% 38%; transform: scale(1.04);';
    }

    return 'object-position: 50% 50%; transform: scale(1.07);';
  }

  createSlideshowHTML(script, visualAssets) {
    const title = this.cleanSlideText(script.title || 'New Story', 56);
    const hero = this.compressSlideText(script.hook?.text || script.introduction?.topicIntro || 'A cinematic story begins here.', 7, 90);
    const hasVisual = Array.isArray(visualAssets) && visualAssets.length > 0;

    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #0f172a 0%, #1d4ed8 40%, #0f172a 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }

        .slide {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 1.5s ease-in-out;
        }

        .slide.active {
            opacity: 1;
        }

        .background-image {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: 50% 50%;
            transform-origin: center center;
            animation: gentlePan 18s ease-in-out infinite alternate;
            filter: saturate(1.1) contrast(1.06) brightness(0.7);
            opacity: 0.9;
            z-index: 0;
        }

        .dark-overlay {
            position: absolute;
            inset: 0;
            background: linear-gradient(180deg, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0.72));
            z-index: 1;
        }

        .content {
            position: relative;
            z-index: 2;
            align-self: flex-end;
            margin: 0 0 56px 56px;
            text-align: left;
            width: min(62%, 760px);
            color: white;
            padding: 18px 24px 20px 24px;
            border-left: 2px solid rgba(255,255,255,0.32);
            background: rgba(15, 23, 42, 0.22);
            backdrop-filter: blur(6px);
            box-shadow: 0 12px 44px rgba(15, 23, 42, 0.18);
        }

        .eyebrow {
            display: inline-block;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: rgba(255,255,255,0.8);
            margin-bottom: 10px;
        }

        h1 {
            font-size: clamp(26px, 2.4vw, 52px);
            margin: 0 0 10px;
            line-height: 1.02;
            letter-spacing: -0.04em;
            text-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
        }

        h2 {
            font-size: clamp(22px, 1.8vw, 38px);
            margin: 0 0 8px;
            line-height: 1.08;
            text-shadow: 0 8px 24px rgba(15, 23, 42, 0.35);
        }

        p {
            margin: 0;
            font-size: clamp(14px, 1.1vw, 20px);
            line-height: 1.45;
            color: rgba(255,255,255,0.9);
            max-width: 42ch;
        }

        .particles {
            position: absolute;
            inset: 0;
            overflow: hidden;
            z-index: 0;
        }

        .particle {
            position: absolute;
            background: rgba(255,255,255,0.68);
            border-radius: 50%;
            animation: float 8s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px); opacity: 0.3; }
            50% { transform: translateY(-24px); opacity: 0.8; }
        }

        @keyframes gentlePan {
            0% { transform: scale(1.04) translate3d(0, 0, 0); }
            100% { transform: scale(1.12) translate3d(-1.5%, -1%, 0); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>

    <div class="slide active">
        ${hasVisual ? `<img class="background-image" src="${visualAssets[0]}" style="${this.getVisualCropStyle(visualAssets[0])}" />` : ''}
        <div class="dark-overlay"></div>
        <div class="content">
            <div class="eyebrow">Cinematic story</div>
            <h1>${title}</h1>
            ${hero ? `<p>${hero}</p>` : ''}
        </div>
    </div>

    ${this.generateContentSlides(script, visualAssets).join('')}

    <script>
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 22; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 7 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 8 + 's';
                container.appendChild(particle);
            }
        }

        const slides = document.querySelectorAll('.slide');
        let currentSlide = 0;
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }

        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];

    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, Math.max(0, visualAssets.length - 1));
        const title = this.cleanSlideText(section.title || `Scene ${index + 1}`, 48);
        const summary = this.compressSlideText(this.formatSectionContent(section), 7, 72);

        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" style="${this.getVisualCropStyle(visualAssets[assetIndex])}" />` : ''}
            <div class="dark-overlay"></div>
            <div class="content">
                <div class="eyebrow">Scene ${index + 1}</div>
                <h2>${title}</h2>
                ${summary ? `<p>${summary}</p>` : ''}
            </div>
        </div>`);
      });
    }

    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      const labels = section.items.slice(0, 2).map(item => this.cleanSlideText(item.title || item.number || '', 24));
      return labels.filter(Boolean).join(' • ');
    }

    if (section.steps && Array.isArray(section.steps)) {
      const labels = section.steps.slice(0, 2).map(step => this.cleanSlideText(step.title || '', 24));
      return labels.filter(Boolean).join(' • ');
    }

    if (typeof section.content === 'string') {
      return this.cleanSlideText(section.content, 60);
    }

    return 'Story movement';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    const videoInput = options.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
    await runFFmpeg([
      '-y', ...videoInput, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', muxPath
    ]);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async burnCaptionsIntoVideo(videoPath, captionsPath, style = 'clean', options = {}) {
    if (!captionsPath || path.extname(captionsPath).toLowerCase() !== '.srt') return videoPath;
    await fs.access(captionsPath);
    const captionedPath = videoPath.replace(/\.mp4$/i, '_captioned.mp4');
    const subtitleFile = captionsPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const alignment = { top: 8, center: 5, bottom: 2 }[options.position] || 2;
    const color = /^#[0-9a-f]{6}$/i.test(options.color || '') ? options.color.slice(1).toUpperCase() : 'FFFFFF';
    const assColor = `&H00${color.slice(4, 6)}${color.slice(2, 4)}${color.slice(0, 2)}`;
    const outline = /^#[0-9a-f]{6}$/i.test(options.outlineColor || '') ? options.outlineColor.slice(1).toUpperCase() : '000000';
    const assOutline = `&H00${outline.slice(4, 6)}${outline.slice(2, 4)}${outline.slice(0, 2)}`;
    const fontSize = Math.max(12, Math.min(40, Number(options.size) || 20));
    const outlineWidth = Math.max(0, Math.min(8, Number(options.outlineWidth) || 2));
    const background = options.background === true ? ',BorderStyle=3,BackColour=&H99000000' : '';
    const styles = {
      clean: `FontName=Arial,FontSize=${fontSize},PrimaryColour=${assColor},OutlineColour=${assOutline},BorderStyle=1,Outline=${outlineWidth},Shadow=0,Alignment=${alignment},MarginV=42${background}`,
      bold: `FontName=Arial,FontSize=${fontSize + 4},Bold=1,PrimaryColour=${assColor},OutlineColour=${assOutline},BorderStyle=1,Outline=${outlineWidth + 1},Shadow=1,Alignment=${alignment},MarginV=48${background}`,
      neon: `FontName=Arial,FontSize=${fontSize + 2},Bold=1,PrimaryColour=${assColor},OutlineColour=${assOutline},BorderStyle=1,Outline=${outlineWidth},Shadow=0,Alignment=${alignment},MarginV=46${background}`,
      minimal: `FontName=Arial,FontSize=${Math.max(12, fontSize - 2)},PrimaryColour=${assColor},OutlineColour=${assOutline},BorderStyle=1,Outline=${Math.max(0, outlineWidth - 1)},Shadow=0,Alignment=${alignment},MarginV=32${background}`
    };
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vf', `subtitles='${subtitleFile}':force_style='${styles[style] || styles.clean}'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', captionedPath
    ]);
    await fs.rename(captionedPath, videoPath);
    this.logger.info('Captions burned into video successfully');
    return videoPath;
  }

  async formatVideoAspect(videoPath, aspectRatio = '16:9') {
    const dimensions = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }[aspectRatio] || [1920, 1080];
    const [width, height] = dimensions;
    const formattedPath = videoPath.replace(/\.mp4$/i, '_formatted.mp4');
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', formattedPath
    ]);
    await fs.rename(formattedPath, videoPath);
    return { width, height };
  }

  async validateVideoFile(videoPath) {
    if (typeof videoPath !== 'string' || path.extname(videoPath).toLowerCase() !== '.mp4') {
      throw new Error('Final video is not an MP4 file');
    }
    const stats = await fs.stat(videoPath).catch(() => null);
    if (!stats?.isFile() || stats.size < 1000) throw new Error('Final MP4 is missing or empty');
    try {
      await runFFmpeg(['-v', 'error', '-i', videoPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    } catch (error) {
      throw new Error(`Final MP4 failed video/audio decoding: ${error.stderr || error.message}`);
    }
    return { bytes: stats.size };
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.openrouterImages && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const timestamp = Date.now();
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${timestamp}.png`);
      const finalPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${timestamp}_final.jpg`);
      const shortTitle = String(script.title || 'New video').replace(/[^\w\s!?'-]/g, '').trim().split(/\s+/).slice(0, 5).join(' ');
      const prompt = `YouTube thumbnail background about "${shortTitle}", ${style} style, one clear central subject, dramatic lighting, strong contrast, uncluttered composition, empty darker space on the left for a title overlay, no text, no logos, no watermark`;

      await this.generateImage(prompt, thumbnailPath);
      await this.createThumbnailOverlay(thumbnailPath, finalPath, shortTitle);

      return {
        path: finalPath,
        dimensions: { width: 1280, height: 720 },
        fileSize: await this.getFileSize(finalPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async createThumbnailOverlay(imagePath, outputPath, title) {
    const words = title.split(/\s+/);
    const midpoint = Math.ceil(words.length / 2);
    const lines = [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')].filter(Boolean);
    const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const text = lines.map((line, index) => `<text x="72" y="${425 + index * 78}" class="title">${escapeXml(line.toUpperCase())}</text>`).join('');
    const overlay = Buffer.from(`<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#05070b" stop-opacity=".88"/><stop offset=".62" stop-color="#05070b" stop-opacity=".15"/><stop offset="1" stop-color="#05070b" stop-opacity="0"/></linearGradient></defs><rect width="1280" height="720" fill="url(#shade)"/><rect x="72" y="150" width="92" height="10" rx="5" fill="#efb866"/>${text}<style>.title{font-family:Arial,sans-serif;font-size:64px;font-weight:800;fill:#fff;stroke:#05070b;stroke-width:3px;paint-order:stroke;}</style></svg>`);
    await sharp(imagePath).resize(1280, 720, { fit: 'cover' }).composite([{ input: overlay }]).jpeg({ quality: 90 }).toFile(outputPath);
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };

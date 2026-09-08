const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { FacelessStockEngine } = require('../utils/faceless-stock-engine');
const { NarrativeStoryEngine } = require('../utils/narrative-story-engine');
const { runFFmpeg } = require('../utils/ffmpeg');
const { CaptionService } = require('../utils/caption-service');
const mediaLibrary = require('../utils/media-library');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials, { db });
    this.captionService = new CaptionService({
      logger: this.logger,
      transcriber: audioPath => this.aiVideoGenerator.transcribeAudioToSrt(audioPath)
    });
    this.sceneRepair = new SceneRepairService(db, this.aiVideoGenerator, { logger: this.logger });
    this.facelessStock = new FacelessStockEngine(credentials, {
      logger: this.logger,
      tts: this.aiVideoGenerator
    });
    this.narrativeStory = new NarrativeStoryEngine(credentials, {
      logger: this.logger,
      visual: this.aiVideoGenerator,
      tts: this.aiVideoGenerator
    });
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, jobId = null } = contentData;
      const strategyContext = contentData.strategyContext || {};
      const musicTrack = strategyContext.musicTrack || null;
      const aspectRatio = ['16:9', '9:16', '1:1'].includes(strategyContext.aspectRatio) ? strategyContext.aspectRatio : '16:9';
      
      // Create production entry
      const productionId = this.generateProductionId();
      
      const productionData = {
        id: productionId,
        strategy,
        strategyContext,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        aspectRatio,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);

      if (await this.shouldUseFacelessStock()) {
        await this.processWithFacelessStock(productionData);
        await this.applyBackgroundMusic(productionData, musicTrack, strategyContext.musicVolume);
        const dimensions = await this.aiVideoGenerator.formatVideoAspect(productionData.assets.finalVideo.path, aspectRatio);
        productionData.assets.finalVideo.resolution = `${dimensions.width}x${dimensions.height}`;
        productionData.assets.finalVideo.aspectRatio = aspectRatio;
        await this.sceneRepair.initializeProduction(productionData, productionData.assets.finalVideo.provider || {});
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
        await this.db.updateProductionData(productionData);
        this.logger.info(`Faceless stock production complete: ${productionId}`);
        return productionData;
      }

      if (await this.shouldUseNarrativeStory()) {
        await this.processWithNarrativeStory(productionData);
        await this.applyBackgroundMusic(productionData, musicTrack, strategyContext.musicVolume);
        const dimensions = await this.aiVideoGenerator.formatVideoAspect(productionData.assets.finalVideo.path, aspectRatio);
        productionData.assets.finalVideo.resolution = `${dimensions.width}x${dimensions.height}`;
        productionData.assets.finalVideo.aspectRatio = aspectRatio;
        await this.sceneRepair.initializeProduction(productionData, productionData.assets.finalVideo.provider || {});
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
        await this.db.updateProductionData(productionData);
        this.logger.info(`Narrative story production complete: ${productionId}`);
        return productionData;
      }
      
      // Generate video content
      await this.generateVideoContent(productionData);
      
      // Generate audio narration
      await this.generateAudioNarration(productionData, strategyContext);
      await this.applyBackgroundMusic(productionData, musicTrack, strategyContext.musicVolume);
      
      // Generate captions
      await this.generateCaptions(productionData);
      
      // Final assembly
      await this.assembleVideo(productionData);

      productionData.providerSummary = {
        video: this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' },
        narration: this.aiVideoGenerator.lastNarrationResult || { provider: productionData.assets.audio?.provider || 'simulation' }
      };
      productionData.costSummary = {
        video: productionData.providerSummary.video.cost || { amount: null, currency: null, status: 'provider-priced' },
        narration: productionData.assets.audio?.cost || { amount: null, currency: null, status: 'provider-priced' }
      };

      // Persist a scene-addressable production manifest for selective review and repair.
      await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {});

      // Mark as ready — or simulated, when no real video could be produced
      const simulated = Boolean(productionData.assets.finalVideo?.simulated);
      if (simulated) {
        productionData.status = 'simulated';
        this.logger.warn(`Content ${productionId} produced PLACEHOLDER assets only — it will NOT be uploaded. Check your AI provider keys and FFmpeg installation.`);
      } else {
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
      }

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  async shouldUseFacelessStock() {
    const configured = process.env.VIDEO_ENGINE || await this.db.getSetting('video_engine');
    return configured === 'faceless_stock';
  }

  async shouldUseNarrativeStory() {
    const configured = process.env.VIDEO_ENGINE || await this.db.getSetting('video_engine');
    return configured === 'narrative_story';
  }

  async processWithFacelessStock(productionData) {
    const outputDir = path.join(__dirname, '..', 'data', 'faceless', productionData.id);
    const result = await this.facelessStock.generate({
      productionId: productionData.id,
      topic: productionData.strategy?.topic || productionData.script?.title,
      script: productionData.script,
      outputDir
    });
    const stats = await fs.stat(result.finalPath);
    productionData.assets.video = {
      duration: result.duration,
      format: 'mp4',
      resolution: '1080x1920',
      fps: 30,
      generatedWith: 'faceless_stock',
      scenes: result.scenes,
      sourceAssets: result.sourceAssets
    };
    productionData.assets.audio = {
      path: result.audioPath,
      format: 'mp3',
      duration: result.duration,
      generatedWith: 'faceless_stock',
      status: 'ready',
      simulated: false,
      provider: result.provider.voice
    };
    productionData.assets.captions = {
      path: result.captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    productionData.assets.finalVideo = {
      path: result.finalPath,
      fileSize: stats.size,
      duration: result.duration,
      generatedWith: 'faceless_stock',
      resolution: '1080x1920',
      format: 'mp4',
      provider: result.provider,
      simulated: false
    };
    productionData.estimatedDuration = result.duration;
    productionData.timeline.audioGenerated = new Date().toISOString();
    productionData.timeline.videoGenerated = new Date().toISOString();
    productionData.timeline.captionsGenerated = new Date().toISOString();
    productionData.containsSyntheticMedia = true;
  }

  async processWithNarrativeStory(productionData) {
    const outputDir = path.join(__dirname, '..', 'data', 'narrative', productionData.id);
    const result = await this.narrativeStory.generate({
      topic: productionData.strategy?.topic || productionData.script?.title,
      script: productionData.script,
      outputDir,
      storyType: productionData.strategy?.storyType || 'general',
      imageStyle: productionData.strategy?.imageStyle || 'cinematic'
    });
    const stats = await fs.stat(result.finalPath);
    productionData.assets.video = {
      duration: result.duration,
      format: 'mp4',
      resolution: '1080x1920',
      fps: 30,
      generatedWith: 'narrative_story',
      scenes: result.scenes,
      characters: result.characters
    };
    productionData.assets.audio = {
      path: result.audioPath,
      format: 'mp3',
      duration: result.duration,
      generatedWith: 'narrative_story',
      status: 'ready',
      simulated: false,
      provider: result.provider.model
    };
    productionData.assets.captions = {
      path: result.captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    productionData.assets.finalVideo = {
      path: result.finalPath,
      fileSize: stats.size,
      duration: result.duration,
      generatedWith: 'narrative_story',
      resolution: '1080x1920',
      format: 'mp4',
      provider: result.provider,
      simulated: false
    };
    productionData.estimatedDuration = result.duration;
    productionData.timeline.audioGenerated = new Date().toISOString();
    productionData.timeline.videoGenerated = new Date().toISOString();
    productionData.timeline.captionsGenerated = new Date().toISOString();
    productionData.containsSyntheticMedia = true;
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        ttsText += `Section ${index + 1}: ${section.title}\n`;
        
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      script.conclusion.recap.forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      ttsText += `${script.callToAction.subscribe}\n`;
      ttsText += `${script.callToAction.like}\n`;
      ttsText += `${script.callToAction.comment}\n`;
    }
    
    return ttsText;
  }

  async processThumbnail(thumbnail, script) {
    try {
      // Try to generate AI thumbnail first
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, this.selectVisualStyle(script));
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI'
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { script } = productionData;
      
      // Generate visual assets using DALL-E
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const requestedMedia = String(productionData.strategy?.mediaAssets || '').split(',').map(value => value.trim()).filter(Boolean);
      const visualAssets = await mediaLibrary.resolveAssets(requestedMedia);
      
      const visualStyle = this.selectVisualStyle(script);
      for (const prompt of visualPrompts) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, visualStyle, 1);
        visualAssets.push(...assets);
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      // Fallback to placeholder
      return await this.createVideoElements(productionData);
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData, options = {}) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS and retain the provider evidence returned by the generator.
      const generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath, {
        provider: options.ttsProvider,
        voiceName: options.voiceName
      });
      const voiceRateValue = Number(options.voiceRate);
      const voiceVolumeValue = Number(options.voiceVolume);
      const voiceRate = Math.max(0.5, Math.min(2, Number.isFinite(voiceRateValue) && voiceRateValue > 0 ? voiceRateValue : 1));
      const voiceVolume = Math.max(0, Math.min(1.5, Number.isFinite(voiceVolumeValue) ? voiceVolumeValue : 1));
      let tunedAudioPath = generatedPath;
      if (voiceRate !== 1 || voiceVolume !== 1) {
        tunedAudioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration_tuned.mp3`);
        await runFFmpeg(['-y', '-i', generatedPath, '-af', `atempo=${voiceRate.toFixed(2)},volume=${voiceVolume.toFixed(2)}`, '-c:a', 'libmp3lame', '-q:a', '4', tunedAudioPath]);
      }
      const evidence = this.aiVideoGenerator.lastNarrationResult || {};
      const usable = await this.aiVideoGenerator.isUsableAudioFile(tunedAudioPath);

      productionData.assets.audio = {
        path: tunedAudioPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: 'AI',
        quality: usable ? 'high' : null,
        status: usable ? 'ready' : 'unavailable',
        simulated: !usable,
        provider: evidence.provider || null,
        model: evidence.model || null,
        externalTaskId: evidence.externalTaskId || null,
        generatedAt: evidence.generatedAt || new Date().toISOString(),
        cost: evidence.cost || {},
        error: usable ? null : 'No live narration provider returned usable audio',
        intentionalSilence: false
      };
      productionData.voice = { provider: options.ttsProvider || 'auto', voice: options.voiceName || null };
      productionData.voice.rate = voiceRate;
      productionData.voice.volume = voiceVolume;
      productionData.subtitleStyle = options.subtitleStyle || 'clean';
      productionData.subtitleOptions = {
        position: ['top', 'center', 'bottom'].includes(options.subtitlePosition) ? options.subtitlePosition : 'bottom',
        color: /^#[0-9a-f]{6}$/i.test(options.subtitleColor || '') ? options.subtitleColor : '#FFFFFF',
        size: Math.max(12, Math.min(40, Number(options.subtitleSize) || 20)),
        background: options.subtitleBackground === 'true',
        outlineColor: /^#[0-9a-f]{6}$/i.test(options.subtitleOutlineColor || '') ? options.subtitleOutlineColor : '#000000',
        outlineWidth: Math.max(0, Math.min(8, Number(options.subtitleOutlineWidth) || 2))
      };

      if (usable) productionData.timeline.audioGenerated = new Date().toISOString();
      return generatedPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error);
    }
  }

  async applyBackgroundMusic(productionData, trackName, musicVolume = 0.16) {
    if (!trackName) return null;
    const musicRoot = path.resolve(__dirname, '..', 'data', 'music');
    const musicPath = path.resolve(musicRoot, path.basename(String(trackName)));
    if (!musicPath.startsWith(`${musicRoot}${path.sep}`)) throw new Error('Background music path is not allowed');
    const source = await fs.stat(musicPath).catch(() => null);
    if (!source?.isFile()) throw new Error(`Background music track was not found: ${trackName}`);

    const musicVolumeValue = Number(musicVolume);
    const volume = Math.max(0, Math.min(1, Number.isFinite(musicVolumeValue) ? musicVolumeValue : 0.16));
    const narrationPath = productionData.assets.audio?.path;
    if (narrationPath && await this.aiVideoGenerator.isUsableAudioFile(narrationPath)) {
      const mixedAudioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_mixed.mp3`);
      await runFFmpeg([
        '-y', '-i', narrationPath, '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', `[0:a]volume=1[narration];[1:a]volume=${volume.toFixed(2)}[music];[narration][music]amix=inputs=2:duration=first:dropout_transition=2[audio]`,
        '-map', '[audio]', '-c:a', 'libmp3lame', '-q:a', '4', mixedAudioPath
      ]);
      productionData.assets.audio.path = mixedAudioPath;
      productionData.assets.audio.backgroundMusic = { track: path.basename(musicPath), volume };
      return mixedAudioPath;
    }

    const finalVideoPath = productionData.assets.finalVideo?.path;
    if (!finalVideoPath || path.extname(finalVideoPath).toLowerCase() !== '.mp4') return null;
    const outputPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_music.mp4`);
    await runFFmpeg([
      '-y', '-i', finalVideoPath, '-stream_loop', '-1', '-i', musicPath,
      '-filter_complex', `[0:a]volume=1[original];[1:a]volume=${volume.toFixed(2)}[music];[original][music]amix=inputs=2:duration=first:dropout_transition=2[audio]`,
      '-map', '0:v:0', '-map', '[audio]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath
    ]);
    await fs.rename(outputPath, finalVideoPath);
    productionData.assets.audio = {
      ...(productionData.assets.audio || {}),
      backgroundMusic: { track: path.basename(musicPath), volume }
    };
    return finalVideoPath;
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    const result = await this.captionService.generate({
      audioPath: productionData.assets.audio?.path,
      outputPath: captionsPath,
      fallback: () => this.createSRTCaptions(productionData)
    });
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true,
      alignment: result.method
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  async createSRTCaptions(productionData) {
    const { script } = productionData;
    let srt = '';
    let captionIndex = 1;
    let currentTime = 0;
    
    // Helper function to format time for SRT
    const formatSRTTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };
    
    // Process script sections for captions
    const processText = (text, startTime, duration) => {
      const words = text.split(' ');
      const wordsPerCaption = 8; // Optimal words per caption
      
      for (let i = 0; i < words.length; i += wordsPerCaption) {
        const captionWords = words.slice(i, i + wordsPerCaption);
        const captionDuration = (duration / Math.ceil(words.length / wordsPerCaption));
        const captionStartTime = startTime + (i / words.length) * duration;
        const captionEndTime = captionStartTime + captionDuration;
        
        srt += `${captionIndex}\n`;
        srt += `${formatSRTTime(captionStartTime)} --> ${formatSRTTime(captionEndTime)}\n`;
        srt += `${captionWords.join(' ')}\n\n`;
        
        captionIndex++;
      }
    };
    
    // Hook
    if (script.hook && script.hook.text) {
      processText(script.hook.text, currentTime, 5);
      currentTime += 5;
    }
    
    // Introduction
    if (script.introduction) {
      const introText = `${script.introduction.greeting} ${script.introduction.topicIntro} ${script.introduction.valueProposition}`;
      processText(introText, currentTime, 15);
      currentTime += 15;
    }
    
    // Main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        let sectionText = '';
        
        if (Array.isArray(section.content)) {
          sectionText = section.content.filter(line => 
            typeof line === 'string' && !line.startsWith('[')
          ).join(' ');
        } else if (section.steps) {
          sectionText = section.steps.map(step => 
            `${step.title}. ${step.description}`
          ).join(' ');
        } else if (section.items) {
          sectionText = section.items.map(item => 
            `Number ${item.number}: ${item.title}. ${item.description}`
          ).join(' ');
        } else if (typeof section.content === 'string') {
          sectionText = section.content;
        }
        
        if (sectionText) {
          processText(sectionText, currentTime, section.duration || 60);
          currentTime += section.duration || 60;
        }
      });
    }
    
    // Conclusion
    if (script.conclusion) {
      const conclusionText = script.conclusion.recap.join(' ') + ' ' + script.conclusion.finalThought;
      processText(conclusionText, currentTime, 30);
      currentTime += 30;
    }
    
    return srt;
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing');
      }

      // Use AI Video Generator to create the final video
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        productionData.assets.audio.path,
        finalVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: productionData.estimatedDuration,
          fitMode: productionData.strategy?.fitMode || 'cover',
          transitionMode: productionData.strategy?.transitionMode || 'fade',
          sceneDuration: Number(productionData.strategyContext?.sceneDuration || 0) || undefined
        }
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      const dimensions = await this.aiVideoGenerator.formatVideoAspect(finalVideoPath, productionData.aspectRatio || '16:9');
      await this.aiVideoGenerator.burnCaptionsIntoVideo(finalVideoPath, productionData.assets.captions?.path, productionData.subtitleStyle || 'clean', productionData.subtitleOptions || {});
      const validatedVideo = await this.aiVideoGenerator.validateVideoFile(finalVideoPath);

      // Get file stats
      const stats = await fs.stat(finalVideoPath);
      
      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: validatedVideo.bytes || stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: `${dimensions.width}x${dimensions.height}`,
        aspectRatio: productionData.aspectRatio || '16:9',
        format: 'mp4',
        provider: this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' }
      };
      productionData.containsSyntheticMedia = Boolean(
        this.aiVideoGenerator.lastVideoResult?.actualProvider &&
        !['slideshow', 'simulation'].includes(this.aiVideoGenerator.lastVideoResult.actualProvider)
      );
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error);
      // Fallback to simulation
      return await this.simulateVideoAssembly(productionData);
    }
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    const prompts = [];
    const sources = [
      script.hook?.text
        ? `${script.hook.text}. Immediate opening hook: show the central subject in a visually surprising moment that creates curiosity in the first seconds.`
        : `${script.title || 'Video topic'}. Immediate opening hook: show the central subject in a visually surprising moment that creates curiosity in the first seconds.`,
      script.title,
      ...Object.values(script.introduction || {}),
      ...(script.mainContent?.sections || []).flatMap(section => [
        section.title,
        ...(Array.isArray(section.content) ? section.content : [section.content]),
        ...(section.steps || []).flatMap(step => [step.title, step.description, step.tip]),
        ...(section.items || []).flatMap(item => [item.title, item.description])
      ]),
      ...(script.conclusion?.recap || []),
      script.conclusion?.finalThought,
      ...Object.values(script.callToAction || {})
    ].filter(value => typeof value === 'string' && value.trim());
    const words = sources.join(' ').replace(/\s+/g, ' ').trim().split(' ');
    const wordsPerBeat = 50;
    for (let start = 0; start < words.length && prompts.length < 12; start += wordsPerBeat) {
      const beat = words.slice(start, start + wordsPerBeat).join(' ');
      prompts.push(`${beat}. Relevant cinematic B-roll, clear subject, varied composition, natural motion, no captions or on-screen text.`);
    }
    while (prompts.length < 3) {
      prompts.push(`${script.title || 'Video topic'}. Relevant cinematic B-roll, clear subject, varied composition, no captions or on-screen text.`);
    }
    return prompts;
  }

  selectVisualStyle(script = {}) {
    const contentType = String(
      script.metadata?.strategy?.contentType || script.contentType || script.type || ''
    ).toLowerCase();
    if (contentType.includes('tutorial') || contentType.includes('how')) return 'modern';
    if (contentType.includes('list') || contentType.includes('review')) return 'animated';
    if (contentType.includes('story') || contentType.includes('horror')) return 'cinematic';
    return 'cinematic';
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData, failure = null) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      status: 'unavailable',
      simulated: true,
      provider: this.aiVideoGenerator.lastNarrationResult?.provider || 'simulation',
      model: this.aiVideoGenerator.lastNarrationResult?.model || null,
      externalTaskId: this.aiVideoGenerator.lastNarrationResult?.externalTaskId || null,
      generatedAt: this.aiVideoGenerator.lastNarrationResult?.generatedAt || new Date().toISOString(),
      cost: this.aiVideoGenerator.lastNarrationResult?.cost || { billed: false },
      error: failure?.message || this.aiVideoGenerator.lastNarrationResult?.error || 'No live narration provider is configured',
      intentionalSilence: false
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData, reason = null) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };

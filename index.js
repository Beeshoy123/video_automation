require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { ProvenanceService } = require('./utils/provenance-service');
const { validateGenerateRequestBody, validateChannelStrategy } = require('./utils/request-validation');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
const { CampaignIntakeService } = require('./utils/campaign-intake-service');
const { TaskManager } = require('./utils/task-manager');
const { VoiceProviderRegistry } = require('./utils/voice-providers');
const { SETTING_KEYS, migrateConfig, buildConfig } = require('./utils/config-schema');
const { registerOperatorRoutes } = require('./routes/operator-routes');
const musicLibrary = require('./utils/music-library');
const mediaLibrary = require('./utils/media-library');
const { version } = require('./package.json');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.generationTasks = new TaskManager({
      maxConcurrent: process.env.MAX_CONCURRENT_JOBS || 1,
      maxQueued: process.env.MAX_QUEUED_JOBS || 100
    });
    this.campaignJobs = new Map();
    this.operator = null;
    this.autonomous = null;
    this.activation = null;
    this.telemetry = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.shorts = null;
    this.campaignIntake = new CampaignIntakeService(__dirname);
    this.setupRequired = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: strategy => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        notify: notification => this.operator.notify(notification)
      });
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      this.localOnlyMode = process.env.LOCAL_ONLY_MODE === 'true';
      const credentialsValid = await this.credentials.validateAll();
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.shorts = new ShortsRepurposingService(this.db, this.agents.publishing, { logger: this.logger });

      // Show which pipeline stages will run for real vs. be simulated
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg && capabilities.hasUpload) {
        await this.activation.markSetupReady(capabilities);
      }
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input)
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') === 'true') {
        await this.scheduler.pauseAutomation();
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      analytics: this.localOnlyMode ? null : new AnalyticsOptimizationAgent(this.db, this.credentials)
    };
    if (this.localOnlyMode) delete this.agents.analytics;
    if (!this.localOnlyMode) {
      this.agents.publishing = new PublishingSchedulingAgent(this.db, this.credentials);
    }

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Image generation (visuals/thumbnails)', ok: hasImages, hint: 'requires an OpenAI or Gemini API key — otherwise gradient slides are used' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure OpenAI, Gemini, ElevenLabs, or Azure Speech — otherwise videos are silent' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasImages, hasTTS, hasFFmpeg, hasUpload };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    return validateGenerateRequestBody(body);
  }

  validateChannelStrategy(body = {}, current = {}) {
    return validateChannelStrategy(body, current);
  }
  setupAPI() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use((req, res, next) => {
      const requestId = String(req.get('X-Request-Id') || crypto.randomUUID()).slice(0, 120);
      req.requestId = requestId;
      res.setHeader('X-Request-Id', requestId);
      const json = res.json.bind(res);
      res.json = body => {
        if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
          return json({ ...body, requestId });
        }
        return json(body);
      };
      next();
    });
    this.app.use('/assets', express.static(path.join(__dirname, 'assets')));
    this.app.use('/fonts', express.static(path.join(__dirname, 'dashboard', 'fonts')));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/api/openapi.json', (_req, res) => {
      res.json({
        openapi: '3.0.3',
        info: { title: 'Video Automation Studio API', version: '2.8.0', description: 'Generate, monitor, review, and publish videos.' },
        servers: [{ url: '/' }],
        security: [{ apiKey: [] }],
        components: {
          securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
          schemas: {
            GenerateRequest: { type: 'object', required: ['length'], properties: { topic: { type: 'string' }, style: { type: 'string' }, length: { type: 'string', enum: ['short', 'medium', 'long'] }, strategyContext: { type: 'object' } } },
            BatchRequest: { type: 'object', required: ['topics', 'length'], properties: { topics: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 200 } }, length: { type: 'string', enum: ['short', 'medium', 'long'] }, strategyContext: { type: 'object' } } },
            Error: { type: 'object', required: ['requestId'], properties: { success: { type: 'boolean' }, error: { type: 'string' }, code: { type: 'string' }, requestId: { type: 'string' } } }
          }
        },
        paths: {
          '/generate': { post: { summary: 'Queue one video', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GenerateRequest' } } } }, responses: { 202: { description: 'Generation job queued' }, 400: { description: 'Invalid request' } } } },
          '/generate/batch': { post: { summary: 'Queue up to 100 videos', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchRequest' } } } }, responses: { 202: { description: 'Batch queued' }, 400: { description: 'Invalid request' } } } },
          '/api/jobs/{jobId}': { get: { summary: 'Read job progress', parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Job status' }, 404: { description: 'Job not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } },
          '/health': { get: { summary: 'Read service health', security: [], responses: { 200: { description: 'Health status' } } } },
          '/api/dashboard': { get: { summary: 'Read dashboard state', responses: { 200: { description: 'Dashboard state' }, 401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } },
          '/api/voices': { get: { summary: 'List voice catalogs and provider readiness', responses: { 200: { description: 'Voice catalogs' } } } },
          '/api/settings': { put: { summary: 'Update channel generation settings', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Settings saved' }, 400: { description: 'Invalid settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } },
          '/api/config/export': { get: { summary: 'Export portable configuration without secrets', responses: { 200: { description: 'Versioned configuration' } } } },
          '/api/config/import': { post: { summary: 'Import versioned configuration', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['schemaVersion', 'profile'] } } } }, responses: { 200: { description: 'Configuration imported' }, 400: { description: 'Unsupported or invalid configuration', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } }
        }
      });
    });

    this.app.get('/api/music', async (_req, res) => {
      try {
        const tracks = await musicLibrary.listTracks();
        res.json({ success: true, tracks });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/voices', (_req, res) => {
      const voices = {
        auto: [],
        openai: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
        gemini: ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Aoede', 'Sulafat'],
        elevenlabs: []
      };
      const providers = this.agents.production?.aiVideoGenerator?.listVoiceProviders?.()
        || new VoiceProviderRegistry().list();
      res.json({ success: true, voices, providers });
    });

    this.app.post('/api/voice-preview', this.requireAPIKey(), async (req, res) => {
      try {
        const text = String(req.body?.text || 'Preview voice narration for your next video.').trim().slice(0, 240);
        const provider = String(req.body?.provider || 'auto').trim().toLowerCase();
        const voiceName = String(req.body?.voiceName || '').trim().slice(0, 80);
        if (!['auto', 'openai', 'gemini', 'elevenlabs'].includes(provider)) return res.status(400).json({ success: false, error: 'Unsupported voice provider' });
        const generator = this.agents.production?.aiVideoGenerator;
        if (!generator) return res.status(503).json({ success: false, error: 'Voice preview is not initialized' });
        const id = `voice-preview-${require('crypto').randomUUID()}`;
        const outputPath = path.join(__dirname, 'data', 'audio', `${id}.mp3`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const generatedPath = await generator.generateTTSAudio(text || 'Preview voice narration for your next video.', outputPath, { provider, voiceName });
        if (!await generator.isUsableAudioFile(generatedPath)) return res.status(422).json({ success: false, error: 'The selected provider did not return usable audio' });
        return res.json({ success: true, result: { url: `/api/voice-preview/${encodeURIComponent(id)}`, provider: generator.lastNarrationResult?.provider || provider, voiceName } });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/voice-preview/:id', async (req, res) => {
      try {
        if (!/^voice-preview-[a-f0-9-]+$/.test(req.params.id)) return res.status(404).end();
        const filePath = path.resolve(__dirname, 'data', 'audio', `${req.params.id}.mp3`);
        if (!filePath.startsWith(`${path.resolve(__dirname, 'data', 'audio')}${path.sep}`)) return res.status(403).end();
        return res.sendFile(filePath);
      } catch (_error) { return res.status(404).end(); }
    });

    this.app.post('/api/music', this.requireAPIKey(), express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '30mb' }), async (req, res) => {
      try {
        const result = await musicLibrary.saveTrack(req.body, req.get('x-file-name'));
        return res.status(201).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/media', async (_req, res) => {
      try { return res.json({ success: true, assets: await mediaLibrary.listAssets() }); }
      catch (error) { return res.status(500).json({ success: false, error: error.message }); }
    });

    this.app.post('/api/media', this.requireAPIKey(), express.raw({ type: ['image/*', 'video/*', 'application/octet-stream'], limit: '200mb' }), async (req, res) => {
      try { return res.status(201).json({ success: true, result: await mediaLibrary.saveAsset(req.body, req.get('x-file-name')) }); }
      catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length, strategyContext } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, strategyContext, source: 'manual', idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/generate/batch', this.requireAPIKey(), async (req, res) => {
      try {
        const topics = Array.isArray(req.body?.topics)
          ? req.body.topics.map(topic => String(topic || '').trim()).filter(Boolean)
          : [];
        if (!topics.length || topics.length > 100) {
          return res.status(400).json({ success: false, error: 'topics must contain between 1 and 100 items' });
        }
        const base = { ...req.body, topic: topics[0] };
        const validation = this.validateGenerateRequestBody(base);
        if (!validation.valid) return res.status(validation.status).json({ success: false, error: validation.error });
        const batchId = `batch_${Date.now().toString(36)}`;
        const input = { ...validation.value, source: 'batch' };
        delete input.topic;
        this.runBatchGeneration(batchId, topics, input).catch(error => this.logger.error(`Batch ${batchId} failed:`, error));
        res.status(202).json({ success: true, result: { batchId, count: topics.length, status: 'queued' } });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        const short = bundle ? null : await this.db.getShortClip(contentId);
        if ((!bundle || bundle.review_status !== 'approved') && (!short || !['scheduled', 'uploading', 'reconciliation_required'].includes(short.status))) {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    registerOperatorRoutes({
      app: this.app,
      db: this.db,
      campaignIntake: this.campaignIntake,
      agents: this.agents,
      activeJobs: this.activeJobs,
      campaignJobs: this.campaignJobs,
      generationTasks: this.generationTasks,
      scheduler: this.scheduler,
      readiness: this.readiness,
      activation: this.activation,
      telemetry: this.telemetry,
      isInitialized: this.isInitialized,
      setupRequired: this.setupRequired,
      logger: this.logger,
      operator: this.operator,
      autonomous: this.autonomous,
      scenes: this.scenes,
      shorts: this.shorts,
      provenance: this.provenance,
      requireAPIKey: this.requireAPIKey.bind(this),
      validateEditorData: this.validateEditorData.bind(this),
      validateProfile: this.validateProfile.bind(this),
      validateChannelStrategy: this.validateChannelStrategy.bind(this),
      decorateContentBundle: this.decorateContentBundle.bind(this),
      refreshContentReview: this.refreshContentReview.bind(this),
      approveContent: this.approveContent.bind(this),
      deleteRejectedProductionAssets: this.deleteRejectedProductionAssets.bind(this),
      startGenerationJob: this.startGenerationJob.bind(this),
      resumeGenerationJob: this.resumeGenerationJob.bind(this),
      startCampaignRenderJob: this.startCampaignRenderJob.bind(this),
      buildConfig,
      migrateConfig,
      SETTING_KEYS
    });
  }

  async startCampaignRenderJob(campaignId, input = {}) {
    const proposals = Array.isArray(input.proposals) ? input.proposals.slice(0, 20) : [];
    if (!proposals.length) {
      const error = new Error('At least one highlight proposal is required');
      error.status = 400;
      throw error;
    }
    if ([...this.campaignJobs.values()].some(job => job.status === 'running' && job.campaignId === campaignId)) {
      const error = new Error('A campaign render job is already running');
      error.status = 429;
      throw error;
    }
    const id = `campaign_job_${require('crypto').randomUUID()}`;
    const job = { id, campaignId, type: 'render_batch', status: 'queued', progress: 0, total: proposals.length, completed: 0, rendered: 0, failed: 0, result: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.campaignJobs.set(id, job);
    job.promise = this.campaignIntake.renderBatch(campaignId, {
      ...input,
      proposals,
      onProgress: progress => {
        Object.assign(job, progress, { progress: Math.round((progress.completed / progress.total) * 100), status: 'running', updatedAt: new Date().toISOString() });
      }
    }).then(result => Object.assign(job, result, { status: 'completed', progress: 100, updatedAt: new Date().toISOString() }))
      .catch(error => Object.assign(job, { status: 'failed', error: error.message, updatedAt: new Date().toISOString() }))
      .finally(() => {
        delete job.promise;
        setTimeout(() => this.campaignJobs.delete(id), 24 * 60 * 60 * 1000);
      });
    return { ...job, promise: undefined };
  }

  async deleteRejectedProductionAssets(bundle) {
    const candidates = new Set();
    const addPath = value => {
      if (typeof value === 'string' && value && !value.startsWith('http')) candidates.add(value);
    };
    const generatedAssetKeys = ['finalVideo', 'thumbnail', 'captions', 'audio', 'script'];
    for (const key of generatedAssetKeys) {
      const asset = bundle.assets?.[key];
      addPath(asset?.path);
      addPath(asset?.originalPath);
    }
    for (const scene of bundle.scenes || []) {
      if (scene.assetOrigin !== 'uploaded') addPath(scene.assetPath);
      addPath(scene.audioPath);
    }
    for (const clip of bundle.shorts || []) {
      addPath(clip.outputPath);
      addPath(clip.captionsPath);
    }

    const allowedRoots = [
      path.resolve(__dirname, 'data', 'audio'),
      path.resolve(__dirname, 'data', 'assets'),
      path.resolve(__dirname, 'data', 'captions'),
      path.resolve(__dirname, 'data', 'production'),
      path.resolve(__dirname, 'data', 'scripts'),
      path.resolve(__dirname, 'data', 'videos'),
      path.resolve(__dirname, 'data', 'shorts'),
      path.resolve(__dirname, 'uploads', 'thumbnails')
    ];
    const deleted = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (!allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) continue;
      try {
        await fs.rm(resolved, { force: true });
        deleted.push(path.relative(__dirname, resolved));
      } catch (error) {
        this.logger.warn(`Could not delete rejected asset ${resolved}: ${error.message}`);
      }
    }
    return deleted;
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const idempotencyKey = String(input.idempotencyKey || '').trim().slice(0, 200) || null;
    if (idempotencyKey) {
      const existing = await this.db.findGenerationJobByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }
    if (!this.generationTasks.canAccept()) {
      const error = new Error(`Generation queue is full (${this.generationTasks.maxQueued} waiting jobs). Try again later.`);
      error.status = 429;
      throw error;
    }

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual',
      idempotencyKey
    });

    const work = this.generationTasks.submit(job.id, () => this.runGenerationJob(job.id, validation.value))
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return job;
  }

  async runBatchGeneration(batchId, topics, input) {
    this.logger.info(`Starting batch ${batchId} with ${topics.length} topics`);
    for (const topic of topics) {
      while (this.activeJobs.size >= Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10))) {
        const active = [...this.activeJobs.values()];
        if (!active.length) break;
        await Promise.race(active);
      }
      try {
        const job = await this.startGenerationJob({ ...input, topic, source: 'batch' });
        await this.waitForGenerationJob(job.id);
      } catch (error) {
        this.logger.error(`Batch ${batchId} topic failed: ${topic}`, error);
      }
    }
    this.logger.info(`Batch ${batchId} completed`);
  }

  async resumeGenerationJob(jobId, options = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted'].includes(job.status)) {
      const error = new Error('Only failed or interrupted generation jobs can be resumed');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(job.id)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (!this.generationTasks.canAccept()) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(job.source)) {
      await this.readiness?.assertReady('Automated generation recovery');
    }

    const checkpoints = await this.db.listGenerationCheckpoints(job.id);
    const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
    if (!GENERATION_STAGES.includes(resumeFrom)) {
      const error = new Error('Resume stage is not supported');
      error.status = 400;
      throw error;
    }
    if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom);
    const input = {
      topic: job.topic,
      style: job.style,
      length: job.length || 'medium',
      strategyContext: job.details?.strategyContext || {}
    };
    const updated = await this.db.updateGenerationJob(job.id, {
      status: 'queued',
      stage: resumeFrom,
      error: null,
      cancelRequested: false,
      completedAt: null,
      details: {
        resumeCount: Number(job.details?.resumeCount || 0) + 1,
        resumeFrom,
        failedStage: null
      }
    });
    const work = this.generationTasks.submit(job.id, () => this.runGenerationJob(job.id, input))
      .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return updated;
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status === 'active') {
      const weeklyOutput = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE source = 'autonomous_operator' AND status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const remaining = Math.max(1, strategy.cadence_per_week - Number(weeklyOutput?.count || 0));
      return this.autonomous.start({
        ...strategy,
        videos_per_run: Math.min(strategy.videos_per_run, remaining)
      });
    }
    return this.startGenerationJob(input);
  }

  async runGenerationJob(jobId, input) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null });
      const result = await this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext
      });
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: {
          reviewStatus: result.reviewStatus,
          qualityScore: result.qualityScore,
          providerSummary: result.providerSummary || null,
          costSummary: result.costSummary || null
        },
        completedAt: new Date().toISOString()
      });
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      return result;
    } catch (error) {
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: { failedStage },
        completedAt: new Date().toISOString()
      });
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext = {} } = options;
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async () => {
      const generated = await this.agents.strategy.generateContentStrategy(topic) || {
        topic: topic || 'A new video idea',
        angle: 'A clear, engaging story built for short-form viewers',
        targetAudience: profile.target_audience || 'General audience',
        contentType: style || profile.default_style || 'story',
        keywords: String(topic || 'video idea').split(/\s+/).filter(Boolean).slice(0, 8),
        createdAt: new Date().toISOString()
      };
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story', 'cartoon']);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = length;
      generated.requestedLength = lengthLabels[length] || lengthLabels.medium;
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.callToAction = profile.call_to_action || null;
      generated.storyType = strategyContext.storyType || null;
      generated.imageStyle = strategyContext.imageStyle || null;
      generated.mediaAssets = strategyContext.mediaAssets || '';
      generated.fitMode = strategyContext.fitMode || 'cover';
      generated.transitionMode = strategyContext.transitionMode || 'fade';
      generated.researchSources = Array.isArray(strategyContext.researchSources)
        ? strategyContext.researchSources
          .map(source => typeof source === 'string' ? { url: source } : source)
          .filter(source => source && typeof source.url === 'string' && source.url.trim())
        : [];
      return generated;
    });
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    const script = await this.runGenerationStage(
      jobId,
      'script',
      25,
      () => this.agents.scriptWriter.generateScript(strategy)
    );
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      () => this.agents.thumbnailDesigner.generateThumbnail(script)
    );
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      () => this.agents.seoOptimizer.optimize(script, strategy)
    );
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      () => this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData, jobId, strategyContext })
    );
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async () => {
      const approvalRequired = await this.db.getSetting('approval_required') !== 'false';
      const packagingExperiment = approvalRequired
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script)
        : null;
      const quality = await this.operator.runQualityChecks(productionData, profile);
      const reviewStatus = quality.passed
        ? (approvalRequired ? 'needs_review' : 'approved')
        : 'needs_attention';
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: packagingExperiment ? {
          packagingExperiment,
          selectedTitleVariant: 0,
          selectedThumbnailVariant: 0
        } : {},
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: approvalRequired ? null : new Date().toISOString()
      });

      let scheduleEntry = null;
      if (reviewStatus === 'approved' && this.agents.publishing) {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
      }

      return {
        contentId,
        title: script.title,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
      };
    });
  }

  async runGenerationStage(jobId, stage, progress, producer) {
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      return producer();
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer);
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script) {
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    const recommendation = approved.find(item => item.proposedChange?.experiment === 'title_thumbnail_variant');
    if (!recommendation) return null;
    try {
      const generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept);
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        status: 'draft',
        titleVariants: this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          { label: 'Control', path: productionData.assets?.thumbnail?.path, concept: thumbnail.concept },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    const sceneLabels = new Map((bundle.scenes || []).map(scene => [scene.id, scene.label]));
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      shorts: (bundle.shorts || []).map(clip => ({
        ...clip,
        sourceSceneLabels: clip.sourceSceneIds.map(id => sceneLabels.get(id)).filter(Boolean),
        assetUrls: {
          video: clip.outputPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/video` : null,
          captions: clip.captionsPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/captions` : null
        }
      })),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async refreshContentReview(productionId, reviewNotes) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    });
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else {
        console.log(chalk.yellow('\n🤖 Automation is active. Approved content will be published on schedule.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };

const path = require('path');
const fs = require('fs').promises;
const express = require('express');

function registerOperatorRoutes(context) {
  const {
    app,
    db,
    campaignIntake,
    agents,
    activeJobs,
    campaignJobs,
    generationTasks,
    scheduler,
    readiness,
    activation,
    telemetry,
    isInitialized,
    setupRequired,
    logger,
    operator,
    autonomous,
    scenes,
    shorts,
    provenance,
    requireAPIKey,
    validateEditorData,
    validateProfile,
    validateChannelStrategy,
    decorateContentBundle,
    refreshContentReview,
    approveContent,
    deleteRejectedProductionAssets,
    startGenerationJob,
    resumeGenerationJob,
    startCampaignRenderJob,
    readOnlyState
  } = context;

  const protect = requireAPIKey();

  app.get('/api/campaigns', async (_req, res) => {
    try { return res.json(await campaignIntake.listCampaigns()); } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.post('/api/campaigns', protect, async (req, res) => {
    try { return res.status(201).json({ success: true, campaign: await campaignIntake.createCampaign(req.body || {}) }); } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
  });

  app.put('/api/campaigns/active', protect, async (req, res) => {
    try { return res.json({ success: true, campaign: await campaignIntake.setActiveCampaign(req.body?.campaignId) }); } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
  });

  app.post('/api/campaigns/:campaignId/caption', protect, async (req, res) => {
    try {
      const config = await campaignIntake.readConfig();
      const campaign = campaignIntake.requireCampaign(req.params.campaignId, config);
      return res.json({ success: true, result: campaignIntake.generateCaption(campaign, req.body || {}) });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code, validation: error.validation }); }
  });

  app.get('/api/campaigns/:campaignId/source-assets', async (req, res) => {
    try {
      return res.json(await campaignIntake.listAssets(req.params.campaignId));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.put('/api/campaigns/:campaignId/source-assets', protect, express.raw({ type: ['video/*', 'application/octet-stream'], limit: '2gb' }), async (req, res) => {
    try {
      const asset = await campaignIntake.ingest(req.params.campaignId, {
        buffer: req.body,
        filename: req.get('x-file-name'),
        sourceFolder: req.get('x-source-folder'),
        contentType: req.get('content-type')
      });
      return res.status(201).json({ success: true, asset });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/campaigns/:campaignId/source-assets/:assetId/analyze', protect, async (req, res) => {
    try {
      const result = await campaignIntake.analyze(req.params.campaignId, req.params.assetId);
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/campaigns/:campaignId/logo', protect, express.raw({ type: ['image/*'], limit: '10mb' }), async (req, res) => {
    try {
      const result = await campaignIntake.saveLogo(req.params.campaignId, { buffer: req.body, filename: req.get('x-file-name'), contentType: req.get('content-type') });
      return res.status(201).json({ success: true, result });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
  });

  app.post('/api/campaigns/:campaignId/clips/render', protect, async (req, res) => {
    try {
      return res.status(201).json({ success: true, result: await campaignIntake.renderClip(req.params.campaignId, req.body || {}) });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
  });

  app.post('/api/campaigns/:campaignId/clips/render-batch', protect, async (req, res) => {
    try {
      const job = await startCampaignRenderJob(req.params.campaignId, req.body || {});
      return res.status(202).json({ success: true, job });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message }); }
  });

  app.get('/api/campaigns/:campaignId/jobs/:jobId', async (req, res) => {
    const job = campaignJobs.get(req.params.jobId);
    if (!job || job.campaignId !== req.params.campaignId) return res.status(404).json({ error: 'Campaign job not found' });
    return res.json({ success: true, job: { ...job, promise: undefined } });
  });

  app.post('/api/campaigns/:campaignId/exports', protect, async (req, res) => {
    try {
      return res.status(201).json({ success: true, result: await campaignIntake.exportPackage(req.params.campaignId, req.body || {}) });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code, report: error.report }); }
  });

  app.get('/api/campaigns/:campaignId/exports/:packageId/:fileName', async (req, res) => {
    try {
      if (!/^[a-zA-Z0-9._-]+$/.test(req.params.packageId) || !/^[a-zA-Z0-9._-]+$/.test(req.params.fileName)) {
        return res.status(400).json({ error: 'Invalid export package path' });
      }
      const allowedFiles = new Set(['tiktok.mp4', 'instagram-reels.mp4', 'youtube-shorts.mp4', 'caption.txt', 'captions.srt', 'compliance-report.json', 'provenance.json']);
      if (!allowedFiles.has(req.params.fileName)) return res.status(404).json({ error: 'Export file not found' });
      const exportRoot = path.resolve(__dirname, '..', 'data', 'campaigns', req.params.campaignId, 'exports');
      const resolved = path.resolve(exportRoot, req.params.packageId, req.params.fileName);
      if (!resolved.startsWith(`${exportRoot}${path.sep}`)) return res.status(403).json({ error: 'Export path is not allowed' });
      await fs.access(resolved);
      return res.download(resolved, req.params.fileName);
    } catch (_error) { return res.status(404).json({ error: 'Export file not found' }); }
  });

  app.post('/api/campaigns/:campaignId/compliance', protect, async (req, res) => {
    try {
      return res.json({ success: true, report: await campaignIntake.reviewPackage(req.params.campaignId, req.body || {}) });
    } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message, report: error.report }); }
  });

  app.get('/api/dashboard', async (_req, res) => {
    try {
      const campaignCatalog = await campaignIntake.listCampaigns();
      const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activationSummary, channelStrategy, operatorRuns, readinessSummary, campaignIntakeAssets] = await Promise.all([
        db.getStats(),
        db.listGenerationJobs(20),
        db.getPipelineOverview(50),
        db.getUpcomingSchedule(30),
        db.getRecentAutomationEvents(20),
        db.listNotifications(20),
        db.getChannelProfile(),
        db.getAllSettings(),
        db.listContentIdeas(),
        agents.analytics
          ? agents.analytics.getRecentAnalytics(30)
          : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
        agents.analytics?.getLearningSummary
          ? agents.analytics.getLearningSummary()
          : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
        activation
          ? activation.getSummary()
          : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} }),
        db.getChannelStrategy(),
        db.listOperatorRuns(10),
        readiness
          ? readiness.getSummary()
          : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
        campaignIntake.listAssets(campaignCatalog.activeCampaignId)
      ]);
      if (telemetry) void telemetry.sync(activationSummary);
      res.json({
        stats,
        jobs,
        pipeline,
        schedule,
        events,
        notifications,
        profile,
        settings,
        ideas,
        analytics,
        learning,
        activation: activationSummary,
        channelStrategy,
        operatorRuns,
        readiness: readinessSummary,
        campaignIntake: campaignIntakeAssets,
        campaignCatalog,
        system: {
          initialized: isInitialized,
          setupRequired,
          uptime: process.uptime(),
          activeJobs: generationTasks.activeCount,
          queuedJobs: generationTasks.queuedCount,
          automationPaused: scheduler ? !scheduler.isEnabled : true,
          agents: Object.keys(agents),
          autonomousRunning: Boolean(await db.getActiveOperatorRun()),
          videoProviders: agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/jobs/:jobId', async (req, res) => {
    const job = await db.getGenerationJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.checkpoints = await db.listGenerationCheckpoints(job.id);
    job.mediaTasks = await db.listMediaGenerationTasks(job.id);
    job.resumeFrom = readiness?.resumePoint ? readiness.resumePoint(job.checkpoints) : undefined;
    return res.json(job);
  });

  app.post('/api/content/:productionId/platform-package', requireAPIKey(), async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ success: false, error: 'Production not found' });
      if (bundle.review_status !== 'approved') return res.status(409).json({ success: false, error: 'Approve the production before creating a platform package' });
      const videoPath = bundle.assets?.finalVideo?.path;
      if (!videoPath || path.extname(videoPath).toLowerCase() !== '.mp4') return res.status(409).json({ success: false, error: 'A real MP4 is required before export' });
      await fs.access(videoPath);
      const outputDir = path.join(__dirname, '..', 'data', 'exports', 'platforms', path.basename(req.params.productionId));
      await fs.mkdir(outputDir, { recursive: true });
      const files = {};
      for (const platform of ['tiktok', 'instagram-reels', 'youtube-shorts']) {
        const target = path.join(outputDir, `${platform}.mp4`);
        await fs.copyFile(videoPath, target);
        files[platform] = path.relative(__dirname, '..', target);
      }
      if (bundle.assets?.captions?.path) {
        const captionsTarget = path.join(outputDir, 'captions.srt');
        await fs.copyFile(bundle.assets.captions.path, captionsTarget);
        files.captions = path.relative(__dirname, '..', captionsTarget);
      }
      const metadataTarget = path.join(outputDir, 'metadata.json');
      await fs.writeFile(metadataTarget, JSON.stringify({
        productionId: bundle.id,
        title: bundle.seo?.title || bundle.script?.title || bundle.strategy?.topic,
        description: bundle.seo?.description || '',
        tags: bundle.seo?.tags || [],
        aspectRatio: bundle.assets.finalVideo.aspectRatio || null,
        createdAt: new Date().toISOString()
      }, null, 2));
      files.metadata = path.relative(__dirname, '..', metadataTarget);
      return res.status(201).json({ success: true, result: { productionId: bundle.id, files } });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
    try {
      const result = await resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
      return res.status(202).json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/readiness', async (_req, res) => {
    if (!readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
    return res.json(await readiness.getSummary());
  });

  app.post('/api/readiness/run', protect, async (req, res) => {
    try {
      if (!readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      const result = await readiness.run({
        includePaidMedia: req.body?.includePaidMedia === true,
        includePaidVideo: req.body?.includePaidVideo === true
      });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
    const job = await db.getGenerationJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['queued', 'running'].includes(job.status)) {
      return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
    }
    const updated = await db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
    return res.json({ success: true, result: updated });
  });

  app.get('/api/content/:productionId', async (req, res) => {
    let bundle = await db.getProductionBundle(req.params.productionId);
    if (!bundle) return res.status(404).json({ error: 'Content not found' });
    if (scenes && !bundle.scenes?.length) {
      await scenes.ensureManifest(bundle);
      bundle = await db.getProductionBundle(req.params.productionId);
    }
    return res.json(decorateContentBundle(bundle));
  });

  app.delete('/api/content/:productionId', protect, async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const deletedAssets = await deleteRejectedProductionAssets(bundle);
      await db.deleteProduction(req.params.productionId);
      return res.json({ success: true, deletedAssets });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
      const result = await scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
        provider: req.query.provider
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
    }
  });

  app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
      const result = await scenes.updateScene(req.params.productionId, req.params.sceneId, req.body || {});
      await refreshContentReview(req.params.productionId, 'Scene changes require review before scheduling');
      return res.json({ success: true, result: scenes.decorateScene(result, req.params.productionId) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
      const result = await scenes.reorder(req.params.productionId, req.body?.sceneIds);
      await refreshContentReview(req.params.productionId, 'Timeline order changed; rebuild and review before scheduling');
      return res.json({ success: true, result: result.map(scene => scenes.decorateScene(scene, req.params.productionId)) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
      const result = await scenes.regenerate(req.params.productionId, req.params.sceneId, req.body || {});
      await refreshContentReview(req.params.productionId, 'Regenerated scene must be rebuilt and reviewed');
      return res.status(202).json({ success: true, result: {
        ...result,
        scene: scenes.decorateScene(result.scene, req.params.productionId)
      } });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.post('/api/content/:productionId/shorts/propose', protect, async (req, res) => {
    try {
      if (!shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
      const result = await shorts.propose(req.params.productionId, req.body || {});
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
  });

  app.patch('/api/content/:productionId/shorts/:clipId', protect, async (req, res) => {
    try {
      if (!shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
      const result = await shorts.update(req.params.productionId, req.params.clipId, req.body || {});
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
  });

  app.post('/api/content/:productionId/shorts/:clipId/render', protect, async (req, res) => {
    try {
      if (!shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
      const result = await shorts.render(req.params.productionId, req.params.clipId);
      return res.status(202).json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
  });

  app.post('/api/content/:productionId/shorts/:clipId/approve', protect, async (req, res) => {
    try {
      if (!shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
      const result = await shorts.approve(req.params.productionId, req.params.clipId, req.body || {});
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
  });

  app.get('/api/content/:productionId/shorts/:clipId/asset/:kind', async (req, res) => {
    try {
      const clip = await db.getShortClip(req.params.clipId);
      if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short asset not found' });
      const filePath = req.params.kind === 'video' ? clip.outputPath : req.params.kind === 'captions' ? clip.captionsPath : null;
      if (!filePath) return res.status(404).json({ error: 'Short asset not found' });
      const resolved = path.resolve(filePath);
      const shortsRoot = path.resolve(__dirname, '..', 'data', 'shorts');
      if (!resolved.startsWith(`${shortsRoot}${path.sep}`)) return res.status(403).json({ error: 'Short asset path is not allowed' });
      await fs.access(resolved);
      return res.sendFile(resolved);
    } catch (_error) {
      return res.status(404).json({ error: 'Short asset not found' });
    }
  });

  app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
      const result = await scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
      await refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
      return res.status(202).json({ success: true, result: scenes.decorateScene(result, req.params.productionId) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
      const result = await scenes.setSilenceOverride(req.params.productionId, req.body || {});
      await refreshContentReview(
        req.params.productionId,
        result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
      );
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.put(
    '/api/content/:productionId/scenes/:sceneId/asset',
    protect,
    express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
    async (req, res) => {
      try {
        if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
          buffer: req.body,
          contentType: req.get('content-type'),
          filename: req.get('x-file-name'),
          rightsConfirmed: req.get('x-rights-confirmed') === 'true',
          containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
        });
        await refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
        return res.json({ success: true, result: scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    }
  );

  app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
    try {
      if (!scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
      const result = await scenes.rebuild(req.params.productionId);
      await refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
    }
  });

  app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
    try {
      const scene = await db.getProductionScene(req.params.productionId, req.params.sceneId);
      if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
      const resolved = path.resolve(scene.assetPath);
      const dataRoot = path.resolve(__dirname, '..', 'data');
      if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
      await fs.access(resolved);
      return res.sendFile(resolved);
    } catch (_error) {
      return res.status(404).json({ error: 'Scene asset not found' });
    }
  });

  app.patch('/api/content/:productionId', protect, async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
        return res.status(409).json({ error: 'Published content cannot be edited here' });
      }
      const editorData = validateEditorData(req.body, bundle.editorData);
      const result = await db.saveContentReview(bundle.id, {
        status: bundle.review_status || 'needs_review',
        editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
        reviewedAt: bundle.reviewed_at
      });
      return res.json({ success: true, result: decorateContentBundle(result) });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/content/:productionId/approve', protect, async (req, res) => {
    try {
      const result = await approveContent(req.params.productionId, req.body || {});
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
    }
  });

  app.post('/api/content/:productionId/reject', protect, async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const deletedAssets = await deleteRejectedProductionAssets(bundle);
      await db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await db.updateProductionStatus(bundle.id, 'rejected');
      return res.json({ success: true, deletedAssets });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/content/:productionId/retry', protect, async (req, res) => {
    const bundle = await db.getProductionBundle(req.params.productionId);
    if (!bundle) return res.status(404).json({ error: 'Content not found' });
    const job = await startGenerationJob({
      topic: bundle.strategy.topic || bundle.editorData.title || null,
      style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
      length: bundle.strategy.requestedLengthKey || 'medium',
      source: 'retry'
    });
    return res.status(202).json({ success: true, result: job });
  });

  app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });

      const workspaceRoot = path.resolve(__dirname, '..');
      const normalizeLegacyAssetPath = (filePath) => {
        if (!filePath || typeof filePath !== 'string') return null;
        const legacyWindowsPrefix = /^[A-Za-z]:\\Users\\HP\\youtube-automation-agent/i;
        const normalized = filePath.replace(legacyWindowsPrefix, workspaceRoot);
        return path.resolve(normalized);
      };

      const allowed = {
        video: [bundle.assets?.finalVideo?.path, bundle.assets?.finalVideo?.originalPath],
        thumbnail: [bundle.assets?.thumbnail?.originalPath, bundle.assets?.thumbnail?.path],
        captions: [bundle.assets?.captions?.path],
        script: [bundle.assets?.script?.originalPath, bundle.assets?.script?.path]
      };

      const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
      const experimentPath = experimentMatch
        ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
        : null;

      const candidatePaths = [...(allowed[req.params.kind] || []), experimentPath]
        .filter(Boolean)
        .flatMap(filePath => {
          const normalized = normalizeLegacyAssetPath(filePath);
          return [filePath, normalized].filter(Boolean);
        })
        .filter((value, index, array) => array.indexOf(value) === index);

      for (const candidatePath of candidatePaths) {
        try {
          await fs.access(candidatePath);
          return res.sendFile(candidatePath);
        } catch (_error) {
          // Try the next candidate.
        }
      }

      return res.status(404).json({ error: 'Asset not found' });
    } catch (_error) {
      return res.status(404).json({ error: 'Asset not found' });
    }
  });

  app.put('/api/profile', protect, async (req, res) => {
    try {
      const profile = validateProfile(req.body || {});
      return res.json({ success: true, result: await db.saveChannelProfile(profile) });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.put('/api/operator/strategy', protect, async (req, res) => {
    try {
      const current = await db.getChannelStrategy() || {};
      const strategy = validateChannelStrategy(req.body || {}, current);
      return res.json({ success: true, result: await db.saveChannelStrategy(strategy) });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/niche/research', protect, async (req, res) => {
    try {
      const niche = String(req.body?.niche || '').trim();
      if (!niche) return res.status(400).json({ success: false, error: 'Tell us what you are interested in first.' });
      if (!agents.strategy || typeof agents.strategy.findNicheSignals !== 'function') {
        return res.status(503).json({ success: false, error: 'Niche research is not available until the strategy agent is configured.' });
      }
      const result = await agents.strategy.findNicheSignals({ niche, region: req.body?.region });
      return res.json({ success: true, result });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/operator/start', protect, async (req, res) => {
    try {
      if (setupRequired || !agents.strategy) {
        return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
      }
      if (activeJobs.size) {
        return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
      }
      await readiness?.assertReady('Autonomous production');
      const current = await db.getChannelStrategy() || {};
      const strategy = validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
      const saved = await db.saveChannelStrategy(strategy);
      const run = await autonomous.start(saved);
      return res.status(202).json({ success: true, result: run });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/operator/pause', protect, async (_req, res) => {
    const strategy = await db.getChannelStrategy();
    if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
    const active = await db.getActiveOperatorRun();
    if (active) await autonomous.cancel(active.id);
    const saved = await db.saveChannelStrategy({ ...strategy, status: 'paused' });
    return res.json({ success: true, result: saved });
  });

  app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
    const run = await autonomous.cancel(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Operator run not found' });
    return res.json({ success: true, result: run });
  });

  app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
    try {
      const bundle = await db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (bundle.review_status === 'approved' || bundle.schedule) {
        return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
      }
      if (!provenance) provenance = new (require('../utils/provenance-service'))(db);
      await provenance.review(bundle.id, req.body || {});
      const updated = await db.getProductionBundle(bundle.id);
      const profile = await db.getChannelProfile() || {};
      const quality = await operator.runQualityChecks({
        ...updated,
        scheduledPublishTime: updated.scheduled_publish_time
      }, profile);
      const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
      const result = await db.saveContentReview(bundle.id, {
        status: reviewStatus,
        editorData: updated.editorData,
        qualityChecks: quality.checks,
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: null
      });
      return res.json({ success: true, result: decorateContentBundle(result) });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
    try {
      if (setupRequired || !agents.strategy) {
        return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
      }
      await readiness?.assertReady('Autonomous production recovery');
      const strategy = await db.getChannelStrategy();
      const run = await autonomous.resume(req.params.runId, strategy);
      return res.status(202).json({ success: true, result: run });
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
    const { recommendationId, action } = req.params;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve or reject' });
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    const recommendation = await db.reviewLearningRecommendation(recommendationId, status);
    if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
    await operator.notify({
      type: 'learning_recommendation_reviewed',
      level: action === 'approve' ? 'success' : 'info',
      title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
      message: recommendation.title,
      data: { recommendationId, status }
    });
    return res.json({ success: true, result: recommendation });
  });

  app.get('/api/retention/:videoId', async (req, res) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
      return res.status(400).json({ error: 'A valid YouTube video ID is required' });
    }
    const snapshots = await db.listRetentionSnapshots({ videoId, limit: 10 });
    return res.json({ success: true, result: snapshots });
  });

  app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
    try {
      const videoId = String(req.params.videoId || '').trim();
      const measurementWindow = String(req.body?.measurementWindow || 'rolling');
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
        return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
      }
      if (!agents.analytics) {
        return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
      }
      const report = await agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
      return res.json({
        success: true,
        result: report.retentionSnapshot || null,
        retention: report.retention
      });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  });

  app.post('/api/ideas', protect, async (req, res) => {
    const topic = String(req.body?.topic || '').trim();
    if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
    const idea = await db.createContentIdea({ ...req.body, topic });
    return res.status(201).json({ success: true, result: idea });
  });

  app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
    const idea = await db.updateContentIdea(req.params.ideaId, req.body || {});
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    return res.json({ success: true, result: idea });
  });

  app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
    const idea = await db.updateContentIdea(req.params.ideaId, { status: 'generating' });
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const job = await startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
    await db.updateContentIdea(idea.id, { status: 'generated' });
    return res.status(202).json({ success: true, result: job });
  });

  app.post('/api/automation/:action', protect, async (req, res) => {
    if (!scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
    const { action } = req.params;
    if (action === 'pause') {
      await scheduler.pauseAutomation();
      await db.setSetting('automation_paused', 'true');
    } else if (action === 'resume') {
      await scheduler.resumeAutomation();
      await db.setSetting('automation_paused', 'false');
    } else {
      return res.status(400).json({ error: 'Action must be pause or resume' });
    }
    return res.json({ success: true, paused: !scheduler.isEnabled });
  });

  app.put('/api/settings', protect, async (req, res) => {
    const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) await db.setSetting(key, String(req.body[key]));
    }
    const provider = req.body?.video_provider;
    if (provider !== undefined) {
      const supported = ['slideshow', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
      if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
      await db.setSetting('video_provider', provider);
    }
    const engine = req.body?.video_engine;
    if (engine !== undefined) {
      if (!['standard', 'faceless_stock', 'narrative_story'].includes(engine)) return res.status(400).json({ error: 'Unsupported video engine' });
      await db.setSetting('video_engine', engine);
    }
    const mode = req.body?.video_generation_mode;
    if (mode !== undefined) {
      if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
      await db.setSetting('video_generation_mode', mode);
    }
    if (req.body?.video_clip_duration !== undefined) {
      const value = Number(req.body.video_clip_duration);
      if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
      await db.setSetting('video_clip_duration', String(value));
    }
    if (req.body?.video_max_generated_seconds !== undefined) {
      const value = Number(req.body.video_max_generated_seconds);
      if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
      await db.setSetting('video_max_generated_seconds', String(value));
    }
    return res.json({ success: true, result: await db.getAllSettings() });
  });

  app.get('/api/config/export', protect, async (_req, res) => {
    const profile = await db.getChannelProfile() || {};
    const settings = await db.getAllSettings();
    res.json(buildConfig(profile, settings));
  });

  app.post('/api/config/import', protect, async (req, res) => {
    try {
      const migrated = migrateConfig(req.body);
      const source = migrated.profile;
      const profile = validateProfile({
        channelName: source.channelName || source.channel_name,
        goal: source.goal,
        targetAudience: source.targetAudience || source.target_audience,
        brandVoice: source.brandVoice || source.brand_voice,
        defaultStyle: source.defaultStyle || source.default_style,
        callToAction: source.callToAction || source.call_to_action,
        visualStyle: source.visualStyle || source.visual_style,
        timezone: source.timezone,
        bannedTopics: source.bannedTopics || source.banned_topics
      });
      await db.saveChannelProfile(profile);
      const settings = migrated.settings;
      if (settings.video_provider !== undefined && !['slideshow', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'].includes(settings.video_provider)) throw new Error('Unsupported video provider');
      if (settings.video_engine !== undefined && !['standard', 'faceless_stock', 'narrative_story'].includes(settings.video_engine)) throw new Error('Unsupported video engine');
      if (settings.video_generation_mode !== undefined && !['hybrid', 'slideshow'].includes(settings.video_generation_mode)) throw new Error('Unsupported video generation mode');
      for (const key of SETTING_KEYS) {
        if (settings[key] !== undefined) await db.setSetting(key, String(settings[key]));
      }
      return res.json({ success: true, result: { profile, settings: await db.getAllSettings(), secretsExcluded: true } });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
    await db.markNotificationRead(req.params.notificationId);
    return res.json({ success: true });
  });
}

module.exports = { registerOperatorRoutes };

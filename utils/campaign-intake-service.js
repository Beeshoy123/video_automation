const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { LocalFfmpegCampaignProvider } = require('./campaign-media-provider');

const DEFAULT_CAMPAIGN = {
  id: 'new-campaign',
  name: 'New campaign',
  approvedFolder: path.join('data', 'campaigns', 'new-campaign', 'approved-footage'),
  allowedExtensions: ['.mp4', '.mov', '.mxf', '.m4v'],
  requiredPhrases: []
};

class CampaignIntakeService {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.mediaProvider = options.mediaProvider || new LocalFfmpegCampaignProvider(options);
    this.configPath = path.resolve(rootDir, 'data', 'campaigns', 'campaigns.json');
  }

  async listCampaigns() {
    const config = await this.readConfig();
    return { activeCampaignId: config.activeCampaignId, campaigns: config.campaigns.map(campaign => this.describe(campaign.id, campaign)) };
  }

  async createCampaign(input = {}) {
    const name = String(input.name || '').trim();
    const id = String(input.id || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!name || !id) throw this.invalid('Campaign name is required');
    const config = await this.readConfig();
    if (config.campaigns.some(campaign => campaign.id === id)) throw this.invalid('A campaign with that ID already exists');
    const campaign = {
      id,
      name: name.slice(0, 120),
      approvedFolder: path.join('data', 'campaigns', id, 'approved-footage'),
      allowedExtensions: ['.mp4', '.mov', '.mxf', '.m4v'],
      requiredPhrases: Array.isArray(input.requiredPhrases) ? input.requiredPhrases.map(value => String(value).trim()).filter(Boolean).slice(0, 20) : [],
      captionPhrase: String(input.captionPhrase || '').trim().slice(0, 500),
      requiredMention: String(input.requiredMention || '').trim().slice(0, 100),
      maxHashtags: Math.max(1, Math.min(10, Number(input.maxHashtags) || 4))
    };
    config.campaigns.push(campaign);
    config.activeCampaignId = id;
    await this.writeConfig(config);
    return this.describe(id, campaign);
  }

  async setActiveCampaign(campaignId) {
    const config = await this.readConfig();
    if (!config.campaigns.some(campaign => campaign.id === campaignId)) throw this.invalid('Unknown campaign');
    config.activeCampaignId = campaignId;
    await this.writeConfig(config);
    return this.describe(campaignId, this.getCampaignFromConfig(config, campaignId));
  }

  getCampaign(campaignId, config) {
    return this.getCampaignFromConfig(config, campaignId);
  }

  getCampaignFromConfig(config, campaignId) {
    return config.campaigns.find(campaign => campaign.id === campaignId) || null;
  }

  async listAssets(campaignId) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    try {
      const manifest = JSON.parse(await fs.readFile(this.manifestPath(campaignId), 'utf8'));
      return { campaign: this.describe(campaignId, campaign), assets: manifest.assets || [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { campaign: this.describe(campaignId, campaign), assets: [] };
    }
  }

  async ingest(campaignId, input = {}) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    const filename = this.safeFilename(input.filename);
    if (String(input.sourceFolder || '').trim() !== campaign.approvedFolder) {
      const error = new Error('Source file is outside the approved campaign folder');
      error.status = 400;
      throw error;
    }
    if (!campaign.allowedExtensions.includes(path.extname(filename).toLowerCase())) {
      const error = new Error('Only approved video file types are accepted: MP4, MOV, MXF, or M4V');
      error.status = 400;
      throw error;
    }
    if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
      const error = new Error('A non-empty video file is required');
      error.status = 400;
      throw error;
    }

    const folder = path.resolve(this.rootDir, campaign.approvedFolder);
    await fs.mkdir(folder, { recursive: true });
    const fileHash = crypto.createHash('sha256').update(input.buffer).digest('hex');
    const storedName = `${fileHash.slice(0, 16)}-${filename}`;
    const filePath = path.resolve(folder, storedName);
    await fs.writeFile(filePath, input.buffer, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });

    const asset = {
      id: `campaign_source_${crypto.randomUUID()}`,
      campaignId,
      filename,
      storedName,
      path: path.relative(this.rootDir, filePath),
      sourceFolder: campaign.approvedFolder,
      mimeType: input.contentType || 'application/octet-stream',
      sizeBytes: input.buffer.length,
      sha256: fileHash,
      provenance: { origin: 'official MediaSilo upload', approvedFolder: campaign.approvedFolder, capturedAt: new Date().toISOString() },
      status: 'approved_source'
    };
    const current = await this.listAssets(campaignId);
    const assets = [...current.assets.filter(item => item.sha256 !== fileHash), asset];
    await fs.writeFile(this.manifestPath(campaignId), JSON.stringify({ campaignId, assets }, null, 2));
    return asset;
  }

  async analyze(campaignId, assetId) {
    const intake = await this.listAssets(campaignId);
    const asset = intake.assets.find(item => item.id === assetId);
    if (!asset) {
      const error = new Error('Approved source asset not found');
      error.status = 404;
      throw error;
    }
    const filePath = this.resolveAssetPath(asset);
    const metadata = await this.mediaProvider.probe(filePath);
    metadata.audioPeak = await this.mediaProvider.detectAudioPeak(filePath);
    const sceneChanges = await this.mediaProvider.detectSceneChanges(filePath);
    const duration = Number(metadata.duration || 0);
    const proposals = this.buildProposals(duration, sceneChanges, metadata.audioPeak);
    const result = { assetId, duration, audio: metadata.audio, sceneChanges, proposals, analyzedAt: new Date().toISOString() };
    await fs.writeFile(this.analysisPath(campaignId, assetId), JSON.stringify(result, null, 2));
    return result;
  }

  async saveLogo(campaignId, input = {}) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    const filename = this.safeFilename(input.filename);
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(filename).toLowerCase())) throw this.invalid('Logo must be a PNG, JPG, JPEG, or WebP image');
    if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) throw this.invalid('A non-empty logo file is required');
    const folder = path.resolve(this.rootDir, 'data', 'campaigns', campaign.id);
    await fs.mkdir(folder, { recursive: true });
    const storedName = `official-logo${path.extname(filename).toLowerCase()}`;
    const logoPath = path.resolve(folder, storedName);
    await fs.writeFile(logoPath, input.buffer);
    campaign.logoPath = path.relative(this.rootDir, logoPath);
    await this.writeConfig(config);
    return { campaign: this.describe(campaign.id, campaign), logoPath: campaign.logoPath };
  }

  async renderClip(campaignId, input = {}) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    const intake = await this.listAssets(campaignId);
    const asset = intake.assets.find(item => item.id === input.assetId);
    if (!asset) throw this.invalid('Approved source asset not found');
    if (!campaign.logoPath) throw this.invalid('Upload the official campaign logo before rendering');
    const sourcePath = this.resolveAssetPath(asset);
    const logoPath = path.resolve(this.rootDir, campaign.logoPath);
    await fs.access(logoPath);
    const startSeconds = Number(input.startSeconds);
    const duration = Number(input.duration);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(duration) || duration < 10 || duration > 30) throw this.invalid('Clip duration must be between 10 and 30 seconds');
    const metadata = await this.mediaProvider.probe(sourcePath);
    if (!metadata.audio) throw this.invalid('Approved source must contain original audio');
    if (startSeconds < 0 || startSeconds + duration > metadata.duration + 0.05) throw this.invalid('Clip window is outside the approved source duration');
    const outputDir = path.resolve(this.rootDir, 'data', 'campaigns', campaignId, 'clips');
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `clip-${Date.now()}.mp4`);
    const captionsPath = `${outputPath}.srt`;
    const caption = this.generateCaption(campaign, input);
    const captionText = caption.text;
    const subtitleText = String(input.subtitleText || input.body || input.captionText || 'Highlight moment').trim();
    await fs.writeFile(captionsPath, this.buildTimedSrt(subtitleText, duration), 'utf8');
    await this.mediaProvider.render(this.buildRenderArgs({ sourcePath, logoPath, outputPath, startSeconds, duration, captionsPath, requiredPhrases: campaign.requiredPhrases }));
    const outputMetadata = await this.mediaProvider.probe(outputPath);
    if (!outputMetadata.audio || outputMetadata.duration < 10) throw new Error('Rendered campaign clip failed MP4 audio or duration validation');
    const result = { campaignId, assetId: asset.id, sourcePath: asset.path, logoPath: campaign.logoPath, outputPath: path.relative(this.rootDir, outputPath), captionsPath: path.relative(this.rootDir, captionsPath), startSeconds, duration, format: '9:16', originalAudioOnly: true, addedMusic: false, provider: this.mediaProvider.describe(), requiredPhrases: campaign.requiredPhrases, captionText, subtitleText, captionValidation: caption.validation, createdAt: new Date().toISOString() };
    await fs.writeFile(`${outputPath}.json`, JSON.stringify(result, null, 2));
    return result;
  }

  buildRenderArgs({ sourcePath, logoPath, outputPath, startSeconds, duration, captionsPath, requiredPhrases = [] }) {
    const text = this.escapeFilterText(requiredPhrases[0] || 'Campaign highlight');
    const secondText = this.escapeFilterText(requiredPhrases[1] || '');
    const subtitlePath = this.escapeSubtitlePath(captionsPath);
    const fontsDir = this.escapeSubtitlePath(path.resolve(this.rootDir, 'dashboard', 'fonts'));
    const subtitles = `subtitles='${subtitlePath}':fontsdir='${fontsDir}':force_style='FontName=Be Vietnam Pro,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=180'`;
    const titleLayer = `drawtext=text='${text}':fontcolor=white:fontsize=52:borderw=3:bordercolor=black:x=(w-text_w)/2:y=100`;
    const secondLayer = secondText ? `,drawtext=text='${secondText}':fontcolor=white:fontsize=48:borderw=3:bordercolor=black:x=(w-text_w)/2:y=175` : '';
    const filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${titleLayer}${secondLayer},${subtitles}[base];[1:v]scale=260:-1[logo];[base][logo]overlay=W-w-42:42:shortest=1,fps=30,format=yuv420p[outv]`;
    return [
      '-y', '-ss', String(startSeconds), '-i', sourcePath,
      '-loop', '1', '-i', logoPath, '-t', String(duration),
      '-filter_complex', filter, '-map', '[outv]', '-map', '0:a:0', '-map_metadata', '-1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-shortest', outputPath
    ];
  }

  async renderBatch(campaignId, input = {}) {
    const proposals = Array.isArray(input.proposals) ? input.proposals.slice(0, 20) : [];
    if (!proposals.length) throw this.invalid('At least one highlight proposal is required');
    const results = [];
    const failures = [];
    for (const [index, proposal] of proposals.entries()) {
      try {
        results.push(await this.renderClip(campaignId, {
          ...input,
          assetId: input.assetId,
          startSeconds: proposal.startSeconds,
          duration: proposal.duration,
          subtitleText: proposal.subtitleText || input.subtitleText,
          body: proposal.body || input.body,
          captionText: proposal.captionText || input.captionText
        }));
      } catch (error) {
        failures.push({ proposalId: proposal.id || null, startSeconds: proposal.startSeconds, duration: proposal.duration, error: error.message });
      }
      if (typeof input.onProgress === 'function') await input.onProgress({ completed: index + 1, total: proposals.length, rendered: results.length, failed: failures.length });
    }
    return { campaignId, requested: proposals.length, rendered: results.length, failed: failures.length, results, failures };
  }

  buildTimedSrt(text, duration) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return '1\n00:00:00,000 --> 00:00:10,000\nHighlight moment\n';
    const chunks = [];
    for (let index = 0; index < words.length; index += 6) chunks.push(words.slice(index, index + 6).join(' '));
    const segment = Number(duration) / chunks.length;
    return chunks.map((chunk, index) => `${index + 1}\n${this.srtTime(index * segment)} --> ${this.srtTime(Math.min(Number(duration), (index + 1) * segment))}\n${chunk}\n`).join('\n');
  }

  srtTime(seconds) {
    const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const secs = Math.floor((milliseconds % 60000) / 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`;
  }

  escapeSubtitlePath(filePath) {
    return path.resolve(filePath).replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
  }

  generateCaption(campaign, input = {}) {
    const body = String(input.body || input.captionBody || input.captionText || 'Highlight moment').trim().replace(/\r?\n/g, ' ');
    const exactPhrase = String(campaign.captionPhrase || '').trim();
    const mention = String(campaign.requiredMention || '').trim();
    const disclosure = ['#Ad', '#Advertisement', '#Sponsored'].includes(input.disclosure) ? input.disclosure : '#Ad';
    const hashtags = (Array.isArray(input.hashtags) ? input.hashtags : String(input.hashtags || '').split(/[ ,]+/))
      .map(tag => String(tag).trim().replace(/^#/, ''))
      .filter(Boolean)
      .filter(tag => !['ad', 'advertisement', 'sponsored'].includes(tag.toLowerCase()));
    const maxAdditional = Math.max(0, (campaign.maxHashtags || 4) - 1);
    const selectedHashtags = [...new Set(hashtags)].slice(0, maxAdditional).map(tag => `#${tag}`);
    const textParts = [body, mention, exactPhrase].filter(Boolean);
    const text = `${textParts.join('\n\n')}\n\n${disclosure}${selectedHashtags.length ? `\n${selectedHashtags.join(' ')}` : ''}`;
    const validation = this.validateCaption(campaign, text);
    if (!validation.valid) {
      const error = this.invalid(`Caption is not compliant: ${validation.errors.join(', ')}`);
      error.code = 'CAPTION_INVALID';
      error.validation = validation;
      throw error;
    }
    return { text, validation };
  }

  validateCaption(campaign, captionText) {
    const caption = String(captionText || '').trim();
    const lines = caption.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const disclosureIndex = lines.findIndex(line => /^(#Ad|#Advertisement|#Sponsored)$/.test(line));
    const firstHashtagIndex = lines.findIndex(line => line.startsWith('#'));
    const hashtags = caption.match(/#[A-Za-z0-9_]+/g) || [];
    const errors = [];
    if (campaign.captionPhrase && !caption.includes(campaign.captionPhrase)) errors.push('exact required phrase is missing');
    if (campaign.requiredMention && !caption.includes(campaign.requiredMention)) errors.push('required account mention is missing');
    if (disclosureIndex < 0 || disclosureIndex !== firstHashtagIndex) errors.push('FTC disclosure must be the first hashtag on its own line');
    if (hashtags.length > (campaign.maxHashtags || 4)) errors.push(`no more than ${campaign.maxHashtags || 4} hashtags are allowed`);
    return { valid: errors.length === 0, errors, disclosure: disclosureIndex >= 0 ? lines[disclosureIndex] : null, hashtagCount: hashtags.length };
  }

  async exportPackage(campaignId, input = {}) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    const report = await this.reviewPackage(campaignId, input);
    const clip = await this.readClipManifest(campaignId, input.outputPath);
    const outputDir = path.resolve(this.rootDir, 'data', 'campaigns', campaignId, 'exports', path.basename(clip.outputPath, '.mp4'));
    await fs.mkdir(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'compliance-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    if (!report.passed) {
      const error = this.invalid('Export blocked: campaign compliance checks failed');
      error.code = 'CAMPAIGN_COMPLIANCE_BLOCKED';
      error.report = report;
      throw error;
    }
    const sourcePath = path.resolve(this.rootDir, clip.outputPath);
    const platformFiles = {};
    for (const platform of ['tiktok', 'instagram-reels', 'youtube-shorts']) {
      const target = path.join(outputDir, `${platform}.mp4`);
      await fs.copyFile(sourcePath, target);
      platformFiles[platform] = path.relative(this.rootDir, target);
    }
    const captionPath = path.join(outputDir, 'caption.txt');
    await fs.writeFile(captionPath, clip.captionText, 'utf8');
    const captionsPath = path.join(outputDir, 'captions.srt');
    await fs.copyFile(path.resolve(this.rootDir, clip.captionsPath), captionsPath);
    const provenancePath = path.join(outputDir, 'provenance.json');
    await fs.writeFile(provenancePath, JSON.stringify({ source: clip.sourcePath, sourceAssetId: clip.assetId, sourceFolder: campaign.approvedFolder, logo: clip.logoPath, generatedClip: clip.outputPath, captions: clip.captionsPath, provider: clip.provider || null }, null, 2));
    return { campaignId, packageId: path.basename(outputDir), passed: true, files: { ...platformFiles, caption: path.relative(this.rootDir, captionPath), captions: path.relative(this.rootDir, captionsPath), complianceReport: path.relative(this.rootDir, reportPath), provenance: path.relative(this.rootDir, provenancePath) }, report };
  }

  async reviewPackage(campaignId, input = {}) {
    const config = await this.readConfig();
    const campaign = this.requireCampaign(campaignId, config);
    const clip = await this.readClipManifest(campaignId, input.outputPath);
    const checks = await this.complianceChecks(campaign, clip);
    return { campaignId, clip: clip.outputPath, generatedAt: new Date().toISOString(), checks, passed: checks.every(check => check.passed) };
  }

  async readClipManifest(campaignId, outputPath) {
    const relative = String(outputPath || '').replaceAll('\\', '/');
    const campaignRoot = path.resolve(this.rootDir, 'data', 'campaigns', campaignId, 'clips');
    const resolved = path.resolve(this.rootDir, relative);
    if (!resolved.startsWith(`${campaignRoot}${path.sep}`) || path.extname(resolved).toLowerCase() !== '.mp4') throw this.invalid('Rendered clip path is not allowed');
    const manifest = JSON.parse(await fs.readFile(`${resolved}.json`, 'utf8'));
    await fs.access(resolved);
    return manifest;
  }

  async complianceChecks(campaign, clip) {
    const outputPath = path.resolve(this.rootDir, clip.outputPath);
    const sourcePath = path.resolve(this.rootDir, clip.sourcePath);
    const logoPath = path.resolve(this.rootDir, clip.logoPath);
    const metadata = await this.mediaProvider.probe(outputPath);
    const sourceInsideFolder = sourcePath.startsWith(`${path.resolve(this.rootDir, campaign.approvedFolder)}${path.sep}`);
    const caption = String(clip.captionText || '').trim();
    const disclosure = /^(#Ad|#Advertisement|#Sponsored)$/im.test(caption);
    const disclosureLine = caption.split(/\r?\n/).findIndex(line => /^(#Ad|#Advertisement|#Sponsored)$/.test(line.trim()));
    const firstHashtag = caption.split(/\r?\n/).findIndex(line => line.trim().startsWith('#'));
    const hashtags = caption.match(/#[A-Za-z0-9_]+/g) || [];
    const exactPhrase = campaign.captionPhrase ? caption.includes(campaign.captionPhrase) : true;
    const mention = campaign.requiredMention ? caption.includes(campaign.requiredMention) : true;
    const checks = [
      { id: 'approved_source', label: 'Approved source asset only', passed: sourceInsideFolder },
      { id: 'logo', label: 'Official logo present', passed: Boolean(clip.logoPath) && await this.exists(logoPath) },
      { id: 'on_screen_text', label: 'Required on-screen phrases recorded', passed: (campaign.requiredPhrases || []).every(phrase => clip.requiredPhrases?.includes(phrase)) },
      { id: 'original_audio', label: 'Original audio only', passed: clip.originalAudioOnly === true && clip.addedMusic === false && metadata.audio },
      { id: 'vertical', label: '9:16 format', passed: metadata.width === 1080 && metadata.height === 1920 },
      { id: 'minimum_duration', label: 'Minimum 10 seconds', passed: metadata.duration >= 10 },
      { id: 'valid_mp4', label: 'Valid MP4 with video and audio', passed: metadata.video && metadata.audio },
      { id: 'english_captions', label: 'English captions present', passed: /[A-Za-z]/.test(caption) && !/[\u0400-\u04FF\u4E00-\u9FFF]/.test(caption) },
      { id: 'timed_captions', label: 'Timed subtitle file present', passed: Boolean(clip.captionsPath) && await this.exists(path.resolve(this.rootDir, clip.captionsPath)) },
      { id: 'caption_phrase', label: 'Exact caption phrase', passed: exactPhrase },
      { id: 'mention', label: 'Required account mention', passed: mention },
      { id: 'ftc_disclosure', label: 'FTC disclosure placement', passed: disclosure && disclosureLine >= 0 && disclosureLine === firstHashtag },
      { id: 'hashtag_limit', label: 'Hashtag limit', passed: hashtags.length <= (campaign.maxHashtags || 4) }
    ];
    return checks;
  }

  escapeFilterText(value) {
    return String(value || '').replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll(',', '\\,');
  }

  resolveAssetPath(asset) {
    const resolved = path.resolve(this.rootDir, asset.path);
    const approvedRoot = path.resolve(this.rootDir, asset.sourceFolder);
    if (!resolved.startsWith(`${approvedRoot}${path.sep}`)) throw new Error('Source asset path is outside the approved folder');
    return resolved;
  }

  async exists(filePath) {
    try { await fs.access(filePath); return true; } catch (_error) { return false; }
  }

  buildProposals(duration, sceneChanges, audioPeak) {
    if (duration < 10) return [];
    const anchors = [0, ...sceneChanges].filter((value, index, values) => value >= 0 && value < duration && values.indexOf(value) === index);
    const proposals = anchors.map((start, index) => {
      const nextCut = anchors[index + 1] || duration;
      const available = Math.max(0, nextCut - start);
      const length = Math.min(30, Math.max(10, available));
      const boundedStart = Math.min(start, Math.max(0, duration - 10));
      return {
        id: `highlight_${index + 1}`,
        startSeconds: Number(boundedStart.toFixed(3)),
        duration: Number(Math.min(length, duration - boundedStart).toFixed(3)),
        signals: { sceneChange: index > 0, highAction: index > 0 || Boolean(audioPeak?.high), audioPeak: audioPeak || null },
        rationale: index > 0 ? 'Scene change anchor with a 10–30 second edit window.' : 'Opening action window; review for satisfying weapon or killstreak moment.',
        eligible: duration - boundedStart >= 10 && duration - boundedStart <= 30
      };
    }).filter(proposal => proposal.eligible);
    return proposals.slice(0, 20);
  }

  analysisPath(campaignId, assetId) {
    return path.resolve(this.rootDir, 'data', 'campaigns', campaignId, `${assetId}-analysis.json`);
  }

  manifestPath(campaignId) {
    return path.resolve(this.rootDir, 'data', 'campaigns', campaignId, 'source-manifest.json');
  }

  describe(campaignId, campaign) {
    return { id: campaignId, name: campaign.name, approvedFolder: campaign.approvedFolder, allowedExtensions: campaign.allowedExtensions, requiredPhrases: campaign.requiredPhrases || [], captionPhrase: campaign.captionPhrase || '', requiredMention: campaign.requiredMention || '', maxHashtags: campaign.maxHashtags || 4, logoPath: campaign.logoPath || null };
  }

  requireCampaign(campaignId, config) {
    const campaign = this.getCampaign(campaignId, config);
    if (!campaign) {
      const error = new Error('Unknown campaign');
      error.status = 404;
      throw error;
    }
    return campaign;
  }

  async readConfig() {
    try {
      const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      return { activeCampaignId: config.activeCampaignId, campaigns: Array.isArray(config.campaigns) ? config.campaigns : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const config = { activeCampaignId: DEFAULT_CAMPAIGN.id, campaigns: [DEFAULT_CAMPAIGN] };
      await this.writeConfig(config);
      return config;
    }
  }

  async writeConfig(config) {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  invalid(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
  }

  safeFilename(value) {
    const filename = path.basename(String(value || '').trim());
    if (!filename || filename === '.' || filename === '..' || filename.length > 180 || /[\0<>:"/\\|?*]/.test(filename)) {
      const error = new Error('A safe video filename is required');
      error.status = 400;
      throw error;
    }
    return filename;
  }
}

module.exports = { CampaignIntakeService };
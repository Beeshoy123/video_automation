const ui = {
  state: null,
  currentView: 'overview',
  overviewStatus: 'Ready',
  refreshing: false,
  toastTimer: null,
  retentionSnapshotId: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function apiKey() {
  return localStorage.getItem('yaa_api_key') || '';
}

function requestApiKey() {
  const key = prompt('Enter the API_KEY value from your .env. It stays in this browser only.', apiKey());
  if (key !== null) localStorage.setItem('yaa_api_key', key.trim());
  return key;
}

async function api(url, options = {}, retry = true) {
  const key = apiKey();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry && requestApiKey() !== null) return api(url, options, false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'Request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function empty(message) {
  return `<div class="empty">${escapeHTML(message)}</div>`;
}

function formatDate(value, includeTime = true) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    ...(ui.state?.profile?.timezone ? { timeZone: ui.state.profile.timezone } : {}),
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
}

function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function label(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function statusChip(value) {
  const safe = String(value || 'unknown').toLowerCase();
  return `<span class="status ${escapeHTML(safe)}">${escapeHTML(label(safe))}</span>`;
}

async function refreshDashboard(silent = false) {
  if (ui.refreshing) return;
  ui.refreshing = true;
  if (!silent) $('#loading').classList.add('active');
  try {
    ui.state = await api('/api/dashboard');
    renderDashboard();
  } catch (error) {
    $('#system-label').textContent = 'Dashboard unavailable';
    $('#system-dot').classList.remove('online');
    if (!silent) showToast(error.message, 'error');
  } finally {
    ui.refreshing = false;
    $('#loading').classList.remove('active');
  }
}

function renderDashboard() {
  const state = ui.state;
  const reviews = state.pipeline.filter(item => ['needs_review', 'needs_attention'].includes(item.review_status));
  const scheduled = state.schedule.filter(item => item.status === 'scheduled');
  const actionableJobs = state.jobs.filter(job => ['queued', 'running', 'failed', 'interrupted'].includes(job.status));

  $('#brand-name').textContent = state.profile?.channel_name || 'Automation Studio';
  $('#setup-banner').classList.toggle('hidden', !state.system.setupRequired);
  $('#system-label').textContent = state.system.setupRequired
    ? 'Setup required'
    : state.system.automationPaused ? 'Automation paused' : `${state.system.agents.length} agents online`;
  $('#system-dot').classList.toggle('online', state.system.initialized && !state.system.automationPaused && !state.system.setupRequired);
  $('#automation-toggle').textContent = state.system.automationPaused ? 'Resume automation' : 'Pause automation';
  $('#automation-toggle').disabled = state.system.setupRequired;
  $('#generate-button')?.setAttribute('aria-disabled', String(state.system.setupRequired));
  $('#top-generate-button').disabled = state.system.setupRequired;
  $('#review-badge').textContent = reviews.length;
  $('#review-badge').classList.toggle('hidden', reviews.length === 0);
  const notificationCount = (state.notifications || []).length || (state.events || []).filter(event => event.status === 'error').length;
  $('#notifications-badge').classList.toggle('hidden', notificationCount === 0);

  $('#stat-review').textContent = reviews.length;
  $('#stat-scheduled').textContent = scheduled.length;
  $('#stat-published').textContent = state.stats.published || 0;
  $('#stat-score').textContent = state.analytics.averagePerformanceScore ? `${state.analytics.averagePerformanceScore}/100` : '—';

  renderLiveStageBar(state.jobs, state.pipeline);
  renderReadyState(state.pipeline);

  renderReviews(reviews);
  renderJobs(actionableJobs.length ? actionableJobs : state.jobs.slice(0, 5));
  renderSchedule(state.schedule.slice(0, 5), '#next-schedule');
  renderNotifications(state.notifications, state.events);
  renderPipeline(state.pipeline);
  renderCampaignIntake(state.campaignIntake);
  renderCalendar(state.schedule);
  renderIdeas(state.ideas);
  renderAnalytics(state.analytics, state.learning);
  renderActivation(state.activation);
  renderReadiness(state.readiness);
  renderOperator(state.channelStrategy, state.operatorRuns || [], { ...state.system, readiness: state.readiness });
  populateSettings(state.profile, state.settings, state.system.videoProviders || []);
}

function activeCampaign() {
  return (ui.state?.campaignCatalog?.campaigns || []).find(campaign => campaign.id === ui.state?.campaignCatalog?.activeCampaignId) || ui.state?.campaignIntake?.campaign || {};
}

function renderCampaignIntake(intake = {}) {
  const assets = Array.isArray(intake.assets) ? intake.assets : [];
  const status = $('#campaign-intake-status');
  const count = $('#campaign-asset-count');
  const list = $('#campaign-asset-list');
  if (!status || !count || !list) return;
  const campaign = activeCampaign();
  $('#active-campaign-name').textContent = campaign.name || 'New campaign';
  $('#campaign-approved-folder').value = campaign.approvedFolder || '';
  $('#active-campaign-folder').textContent = campaign.approvedFolder ? `Approved folder: ${campaign.approvedFolder}` : '';
  const selector = $('#active-campaign-select');
  selector.innerHTML = (ui.state?.campaignCatalog?.campaigns || []).map(item => `<option value="${escapeHTML(item.id)}" ${item.id === ui.state?.campaignCatalog?.activeCampaignId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('');
  status.textContent = assets.length ? `${assets.length} approved file${assets.length === 1 ? '' : 's'}` : 'No footage';
  status.className = `status ${assets.length ? 'success' : 'warning'}`;
  count.textContent = `${assets.length} file${assets.length === 1 ? '' : 's'}`;
  list.innerHTML = assets.length ? assets.slice().reverse().map(asset => `<article class="campaign-asset"><div><strong>${escapeHTML(asset.filename)}</strong><span>${escapeHTML(asset.mimeType)} · ${(Number(asset.sizeBytes || 0) / 1024 / 1024).toFixed(1)} MB</span></div><div><span class="status success">Approved source</span><small>SHA-256 ${escapeHTML(asset.sha256.slice(0, 16))}… · ${formatDate(asset.provenance?.capturedAt)}</small><button type="button" class="button secondary small" data-analyze-campaign-asset="${escapeHTML(asset.id)}">Analyze highlights</button></div></article>`).join('') : empty('Upload the first approved MediaSilo file to begin clip selection.');
}

function renderLiveStageBar(jobs = [], pipeline = []) {
  const stageBar = $('#live-stage-bar');
  if (!stageBar) return;
  const activeJob = jobs.find(job => ['queued', 'running', 'failed', 'interrupted'].includes(job.status));
  const latest = pipeline[0] || {};
  ui.overviewStatus = activeJob?.status === 'failed' || activeJob?.status === 'interrupted'
    ? 'Needs attention'
    : activeJob ? 'In progress'
      : latest.review_status === 'needs_review' || latest.review_status === 'needs_attention' ? 'Finished'
        : 'Ready';
  const statusNode = $('#live-status-label');
  if (!statusNode) return;
  statusNode.textContent = ui.overviewStatus;
  statusNode.className = ui.overviewStatus === 'Ready' || ui.overviewStatus === 'Finished' ? 'ready' : ui.overviewStatus === 'In progress' ? 'active' : 'attention';
  statusNode.setAttribute('aria-label', `Video status: ${ui.overviewStatus}`);
  const stageSteps = $('#live-stage-steps');
  if (!stageSteps) return;
  const stage = activeJob?.stage || latest.review_status || 'strategy';
  const stageMap = { strategy: 'brief', script: 'script', thumbnail: 'visuals', seo: 'visuals', production: 'assembly', quality_review: 'review', needs_review: 'review', needs_attention: 'review', approved: 'review', published: 'review' };
  const activeStage = stageMap[stage] || stage;
  const stages = ['brief', 'script', 'visuals', 'voice', 'assembly', 'review'];
  const activeIndex = Math.max(0, stages.indexOf(activeStage));
  stageSteps.querySelectorAll('[data-stage]').forEach((node, index) => {
    const isComplete = index < activeIndex;
    const isActive = node.dataset.stage === activeStage && Boolean(activeJob || latest.review_status);
    node.classList.toggle('active', isActive);
    node.classList.toggle('complete', isComplete);
    node.title = node.textContent;
  });
  stageSteps.querySelectorAll('i').forEach((node, index) => node.classList.toggle('complete', index < activeIndex));
}

function renderReadyState(pipeline = []) {
  const panel = $('#ready-state-panel');
  if (!panel) return;
  const item = pipeline.find(entry => ['needs_review', 'needs_attention'].includes(entry.review_status));
  if (!item) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const title = item.title || item.topic || 'Your latest video';
  const attention = item.review_status === 'needs_attention';
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="ready-state-heading"><div><span class="ready-kicker">${attention ? 'FINISHING TOUCHES' : 'READY FOR REVIEW'}</span><h2>${escapeHTML(title)}</h2><p>${attention ? 'A few checks need your attention before this can be approved.' : 'Your video is ready.'}</p></div><span class="ready-state-icon">${attention ? '!' : '✓'}</span></div><div class="ready-checks"><span class="${item.hasVideo || item.assetUrls?.video ? 'done' : ''}">✓ Video rendered</span><span class="${item.audioReady || item.assets?.audio?.status === 'ready' ? 'done' : ''}">✓ Narration ready</span><span class="${item.captionsReady || item.assets?.captions?.status === 'ready' ? 'done' : ''}">✓ Captions generated</span><span class="${item.rightsReviewed || item.provenance?.status === 'verified' || item.provenance?.status === 'not_required' ? 'done' : ''}">✓ Rights reviewed</span><span class="attention">! Approval required</span></div><div class="ready-state-actions"><button type="button" class="button secondary" data-open-content="${escapeHTML(item.id)}">Preview video</button><button type="button" class="button primary" data-open-content="${escapeHTML(item.id)}">Open review</button></div>`;
}

function renderReadiness(readiness = {}) {
  const status = readiness.status || 'unverified';
  const statusNode = $('#readiness-status');
  statusNode.className = `status ${escapeHTML(status)}`;
  statusNode.textContent = readiness.stale && status !== 'unverified' ? `${label(status)} · stale` : label(status);

  const titles = {
    passed: 'The production path is verified.',
    warning: 'Core checks passed with warnings.',
    failed: 'Automation is blocked until this is fixed.',
    unverified: 'Prove the pipeline, without uploading.'
  };
  $('#readiness-title').textContent = titles[status] || titles.unverified;
  const counts = readiness.summary || {};
  $('#readiness-summary').textContent = status === 'unverified'
    ? 'The check makes small live text and narration requests, verifies channel access, builds a local audio/video MP4, and validates queued metadata. It never creates or uploads a YouTube video.'
    : `${counts.passed || 0} passed, ${counts.warnings || 0} warning${counts.warnings === 1 ? '' : 's'}, and ${counts.failed || 0} failed.`;
  $('#readiness-meta').textContent = readiness.completed_at
    ? `Last run ${formatDate(readiness.completed_at)}${readiness.stale ? ' · older than 24 hours' : ''}`
    : 'No readiness run recorded.';

  const statusPriority = { failed: 0, warning: 1, skipped: 2, passed: 3 };
  const checks = Array.isArray(readiness.checks)
    ? readiness.checks
      .map((check, index) => ({ check, index }))
      .sort((left, right) => (statusPriority[left.check.status] ?? 4) - (statusPriority[right.check.status] ?? 4) || left.index - right.index)
      .map(({ check }) => check)
    : [];
  $('#readiness-checks').innerHTML = checks.length ? checks.map(check => `
    <article class="readiness-check ${escapeHTML(check.status)}">
      <div class="readiness-check-heading"><span class="readiness-icon" aria-hidden="true">${check.status === 'passed' ? '✓' : check.status === 'failed' ? '×' : '!'}</span><div><strong>${escapeHTML(check.label)}</strong><div class="meta-line">${escapeHTML(label(check.status))}${check.blocking ? ' · blocking' : ' · optional'} · ${(check.durationMs || 0) / 1000}s</div></div></div>
      <p>${escapeHTML(check.message)}</p>
      ${check.remediation ? `<small><strong>Next:</strong> ${escapeHTML(check.remediation)}</small>` : ''}
    </article>`).join('') : empty('Run the verified check to inspect every production dependency.');
}

function renderReviews(reviews) {
  const container = $('#review-list');
  if (!reviews.length) {
    container.innerHTML = empty('Nothing is waiting. New content will appear here after quality review.');
    return;
  }
  container.innerHTML = reviews.slice(0, 5).map(item => `
    <article class="review-card">
      ${item.hasThumbnail ? `<img class="review-thumb" src="/api/content/${encodeURIComponent(item.id)}/asset/thumbnail" alt="">` : '<div class="review-thumb"></div>'}
      <div class="review-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${statusChip(item.review_status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div>
      <button class="button secondary small" data-open-content="${escapeHTML(item.id)}">Review</button>
    </article>`).join('');
}

function renderJobs(jobs) {
  const container = $('#job-list');
  if (!jobs.length) {
    container.innerHTML = empty('No generation runs yet.');
    return;
  }
  const stages = ['strategy', 'script', 'thumbnail', 'seo', 'production', 'quality_review'];
  const stageLabels = ['Brief', 'Script', 'Visuals', 'Voice', 'Assembly', 'Review'];
  container.innerHTML = jobs.slice(0, 6).map(job => {
    const checkpoints = Array.isArray(job.checkpoints) ? job.checkpoints : [];
    const checkpointMap = new Map(checkpoints.map(item => [item.stage, item]));
    const completed = new Set(checkpoints.filter(item => item.status === 'completed').map(item => item.stage));
    const mediaTasks = Array.isArray(job.mediaTasks) ? job.mediaTasks : [];
    const mediaCompleted = mediaTasks.filter(item => item.status === 'succeeded').length;
    const mediaProviders = [...new Set(mediaTasks.map(item => label(item.provider)))].join(', ');
    const resumeFrom = stages.find(stage => !completed.has(stage)) || 'quality_review';
    const recoverable = ['failed', 'interrupted'].includes(job.status);
    const activeIndex = Math.max(0, stages.indexOf(job.stage));
    const stageStatus = (stage, index) => {
      const checkpoint = checkpointMap.get(stage);
      if (checkpoint?.status === 'failed' || (job.status === 'failed' && stage === job.stage)) return 'failed';
      if (checkpoint?.status === 'completed' || index < activeIndex || (job.status === 'completed' && index === stages.length - 1)) return 'complete';
      if (['running', 'queued'].includes(job.status) && stage === job.stage) return 'running';
      if (job.status === 'interrupted' && stage === job.stage) return 'attention';
      return 'waiting';
    };
    const stageCards = stages.map((stage, index) => {
      const status = stageStatus(stage, index);
      const symbol = { complete: '✓', running: '•', waiting: '○', failed: '×', attention: '!' }[status];
      return `<div class="generation-stage ${status}"><span class="generation-stage-icon">${symbol}</span><strong>${stageLabels[index]}</strong><small>${label(status)}</small></div>`;
    }).join('<i class="generation-connector"></i>');
    const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
    const elapsedMs = job.created_at ? Date.now() - new Date(job.created_at).getTime() : 0;
    const eta = progress > 2 && elapsedMs > 0 ? `${Math.max(1, Math.ceil((elapsedMs * (100 - progress) / progress) / 60000))} min left` : 'Estimating time';
    const cost = job.details?.actualCost?.amount ?? job.details?.cost?.amount ?? job.details?.estimatedCost?.amount;
    return `
    <article class="job-card detailed-job-card">
      <div class="job-meta">
        <strong>${escapeHTML(job.title || job.topic || 'Agent-selected topic')}</strong>
        <div class="meta-line">${statusChip(job.status)} · ${escapeHTML(label(job.stage))} · ${timeAgo(job.updated_at)}</div>
        <div class="generation-stage-track">${stageCards}</div>
        <div class="generation-meta"><span>${progress}% complete</span><span>${escapeHTML(eta)}</span>${cost !== undefined ? `<span>Cost ${escapeHTML(String(cost))}</span>` : '<span>Cost pending</span>'}</div>
        ${checkpoints.length ? `<div class="checkpoint-line">${completed.size}/${stages.length} stages saved${job.details?.reusedStages?.length ? ` · ${job.details.reusedStages.length} reused` : ''}</div>` : ''}
        ${mediaTasks.length ? `<div class="checkpoint-line">Video: ${mediaCompleted}/${mediaTasks.length} clips ready · ${escapeHTML(mediaProviders)}</div>` : ''}
        ${mediaCompleted && job.production_id ? `<div class="partial-preview-strip"><img src="/api/content/${encodeURIComponent(job.production_id)}/asset/thumbnail" alt="Partial production preview"><span>${mediaCompleted} visual${mediaCompleted === 1 ? '' : 's'} ready to preview</span></div>` : ''}
        <div class="progress"><i style="width:${progress}%"></i></div>
      </div>
      ${['queued', 'running'].includes(job.status) ? `<button class="text-button" data-cancel-job="${escapeHTML(job.id)}">Cancel</button>` : ''}
      ${recoverable ? `<div class="job-recovery"><select data-resume-stage-for="${escapeHTML(job.id)}" aria-label="Stage to retry from">${stages.map(stage => `<option value="${stage}" ${stage === resumeFrom ? 'selected' : ''}>${escapeHTML(stageLabels[stages.indexOf(stage)])}</option>`).join('')}</select><button class="button secondary small" data-resume-job="${escapeHTML(job.id)}">Retry from stage</button></div>` : ''}
    </article>`;
  }).join('');
}

function renderSchedule(schedule, selector) {
  const container = $(selector);
  if (!schedule.length) {
    container.innerHTML = empty('No approved videos are scheduled.');
    return;
  }
  container.innerHTML = schedule.map(item => `
    <div class="timeline-item">
      <div class="date-chip"><small>${escapeHTML(new Date(item.publish_time).toLocaleDateString(undefined, { month: 'short' }))}</small><strong>${escapeHTML(new Date(item.publish_time).getDate())}</strong></div>
      <div class="timeline-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${formatDate(item.publish_time)} · ${statusChip(item.status)}</div></div>
      <button class="text-button" data-open-content="${escapeHTML(item.production_id)}">View</button>
    </div>`).join('');
}

function renderNotifications(notifications, events) {
  const items = notifications.length
    ? notifications
    : events.map(event => ({ level: event.status === 'error' ? 'error' : 'info', title: label(event.event_type), message: event.data?.error || label(event.status), created_at: event.created_at }));
  const container = $('#notification-list');
  if (!items.length) {
    container.innerHTML = empty('No activity has been recorded yet.');
    return;
  }
  container.innerHTML = items.slice(0, 7).map(item => `
    <div class="activity ${escapeHTML(item.level || 'info')}"><i></i><p><strong>${escapeHTML(item.title)}</strong><br><span class="meta-line">${escapeHTML(item.message)}</span></p><small>${timeAgo(item.created_at)}</small></div>`).join('');
}

function renderGlobalSearch(query = '') {
  const term = query.trim().toLowerCase();
  const state = ui.state || {};
  const items = [
    ...(state.pipeline || []).map(item => ({ id: item.id, title: item.title || item.topic || 'Untitled production', meta: `Pipeline · ${label(item.review_status || item.status)}`, open: item.id })),
    ...(state.ideas || []).map(item => ({ title: item.topic || 'Untitled idea', meta: `Idea · ${label(item.status || 'backlog')}` })),
    ...(state.jobs || []).map(item => ({ title: item.title || item.topic || 'Generation job', meta: `Job · ${label(item.status)}` }))
  ].filter(item => !term || `${item.title} ${item.meta}`.toLowerCase().includes(term)).slice(0, 12);
  const container = $('#global-search-results');
  if (!container) return;
  container.innerHTML = items.length
    ? items.map(item => `<button type="button" class="search-result" ${item.open ? `data-open-content="${escapeHTML(item.open)}"` : ''}><span><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.meta)}</small></span><span aria-hidden="true">→</span></button>`).join('')
    : empty(term ? 'No matching content found.' : 'Search your pipeline, ideas, and generation jobs.');
}

function currentPipelineFilter() {
  return $('#pipeline-filter').value || 'all';
}

function renderPipeline(items) {
  const filter = currentPipelineFilter();
  const filtered = filter === 'all' ? items : items.filter(item =>
    item.review_status === filter || item.schedule_status === filter || item.status === filter
  );
  const container = $('#pipeline-list');
  if (!filtered.length) {
    container.innerHTML = empty('No content matches this view.');
    return;
  }
  container.innerHTML = filtered.map(item => {
    const state = item.schedule_status || item.review_status || item.status;
    const next = nextAction(item);
    return `<article class="pipeline-item" data-open-content="${escapeHTML(item.id)}">
      <div class="pipeline-title"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.topic || 'No topic recorded')} · ${formatDate(item.created_at)}</span></div>
      <div class="pipeline-col"><span>State</span><strong>${statusChip(state)}</strong></div>
      <div class="pipeline-col"><span>Quality</span><strong>${qualityScore(item.qualityChecks)} / 100</strong></div>
      <button class="button secondary small">${escapeHTML(next)} →</button>
    </article>`;
  }).join('');
}

function qualityScore(checks) {
  if (!Array.isArray(checks) || !checks.length) return 0;
  return Math.round((checks.filter(check => check.passed).length / checks.length) * 100);
}

function nextAction(item) {
  if (item.schedule_status === 'published') return 'View';
  if (item.review_status === 'needs_attention') return 'Fix issues';
  if (item.review_status === 'needs_review') return 'Review';
  if (item.schedule_status === 'scheduled') return 'Scheduled';
  return 'Inspect';
}

function renderCalendar(schedule) {
  renderSchedule(schedule, '#calendar-list');
}

function renderIdeas(ideas) {
  const container = $('#idea-list');
  if (!ideas.length) {
    container.innerHTML = empty('Add promising topics here before spending generation credits.');
    return;
  }
  container.innerHTML = ideas.map(idea => `
    <article class="idea-card">
      <div class="idea-meta"><strong>${escapeHTML(idea.topic)}</strong><div class="meta-line">${escapeHTML(idea.angle || idea.rationale || 'No angle added')} · ${statusChip(idea.status)}</div></div>
      ${idea.status === 'backlog' ? `<button class="button secondary small" data-generate-idea="${escapeHTML(idea.id)}">Generate</button>` : ''}
    </article>`).join('');
}

function renderAnalytics(analytics, learning = {}) {
  $('#analytics-total').textContent = analytics.totalVideos || 0;
  $('#analytics-score').textContent = analytics.averagePerformanceScore ? `${analytics.averagePerformanceScore}/100` : '—';
  const insights = Array.isArray(analytics.insights) ? analytics.insights : [];
  const approved = (learning.recommendations || []).find(item => item.status === 'approved');
  const pending = (learning.recommendations || []).find(item => item.status === 'pending');
  $('#analytics-action').textContent = approved?.title || pending?.title || insights[0] || (analytics.totalVideos
    ? 'Keep collecting results; recommendations get stronger with more published videos.'
    : 'Publish and analyze the first video to unlock performance recommendations.');
  const performers = Array.isArray(analytics.topPerformers) ? analytics.topPerformers : [];
  $('#top-performers').innerHTML = performers.length ? performers.map(item => `
    <article class="performer-card"><strong>${escapeHTML(item.videoDetails?.title || item.title || 'Untitled video')}</strong><div class="meta-line">Performance ${escapeHTML(item.performance?.score ?? item.performance_score ?? '—')} / 100</div></article>`).join('') : empty('No analyzed videos yet.');
  renderLearning(learning);
  renderRetention(learning.retention || {});
}

function renderLearning(learning = {}) {
  const baseline = learning.baseline || {};
  $('#learning-snapshot-count').textContent = `${learning.snapshotCount || 0} snapshots`;
  $('#learning-approved-count').textContent = `${learning.approvedCount || 0} approved`;
  const metrics = [
    ['CTR', baseline.ctr, '%'],
    ['Retention', baseline.retention, '%'],
    ['Engagement', baseline.engagementRate, '%'],
    ['Performance', baseline.performanceScore, '/100']
  ];
  $('#learning-baseline').innerHTML = learning.measuredVideos ? metrics.map(([name, value, suffix]) => `
    <div><span>${escapeHTML(name)}</span><strong>${Number(value || 0).toFixed(1)}${escapeHTML(suffix)}</strong></div>`).join('') : empty('Two real measurements unlock evidence-backed recommendations.');

  const recommendations = Array.isArray(learning.recommendations) ? learning.recommendations : [];
  $('#learning-recommendations').innerHTML = recommendations.length ? recommendations.map(item => `
    <article class="learning-card">
      <div class="learning-card-heading"><strong>${escapeHTML(item.title)}</strong>${statusChip(item.status)}</div>
      <p>${escapeHTML(item.rationale)}</p>
      <div class="learning-meta"><span>${escapeHTML(label(item.category))} · ${escapeHTML(label(item.confidence))} confidence</span>
        <span class="learning-actions">
          ${item.status !== 'approved' ? `<button class="text-button approve" data-learning-action="approve" data-learning-id="${escapeHTML(item.id)}">Approve</button>` : ''}
          ${item.status !== 'rejected' ? `<button class="text-button" data-learning-action="reject" data-learning-id="${escapeHTML(item.id)}">Reject</button>` : ''}
        </span>
      </div>
    </article>`).join('') : empty('No recommendation yet. Lumen needs at least two real, sufficiently exposed measurements.');
}

function renderRetention(retention = {}) {
  const snapshots = Array.isArray(retention.snapshots) ? retention.snapshots : [];
  const select = $('#retention-snapshot-select');
  const refresh = $('#refresh-retention-button');
  if (!snapshots.length) {
    ui.retentionSnapshotId = null;
    select.innerHTML = '<option value="">No measured curves yet</option>';
    select.disabled = true;
    refresh.disabled = true;
    $('#retention-meta').innerHTML = '';
    $('#retention-chart').innerHTML = empty('Retention curves appear after a published video reaches a real analytics measurement window.');
    $('#retention-scenes').innerHTML = '';
    return;
  }

  if (!snapshots.some(item => item.id === ui.retentionSnapshotId)) ui.retentionSnapshotId = snapshots[0].id;
  select.disabled = false;
  refresh.disabled = false;
  select.innerHTML = snapshots.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === ui.retentionSnapshotId ? 'selected' : ''}>${escapeHTML(item.title || item.videoId)} · ${escapeHTML(label(item.surface))} · ${escapeHTML(item.measurementWindow)}</option>`).join('');
  const snapshot = snapshots.find(item => item.id === ui.retentionSnapshotId) || snapshots[0];
  refresh.dataset.videoId = snapshot.videoId;
  refresh.dataset.measurementWindow = snapshot.measurementWindow;

  const summary = snapshot.summary || {};
  $('#retention-meta').innerHTML = [
    `${snapshot.points?.length || 0} real points`,
    `${snapshot.sceneMetrics?.length || 0} scenes`,
    `${summary.dropoffCount || 0} drop-offs`,
    `${summary.rewatchCount || 0} rewatch signals`,
    `${escapeHTML(label(snapshot.confidence))} confidence`,
    `${escapeHTML(snapshot.measurementWindow)} window`
  ].map(item => `<span>${item}</span>`).join('');
  $('#retention-chart').innerHTML = retentionChart(snapshot);
  $('#retention-scenes').innerHTML = (snapshot.sceneMetrics || []).map(scene => `
    <article class="retention-scene ${escapeHTML(scene.signal)}">
      <div class="retention-scene-heading"><div><span>Scene ${Number(scene.position || 0) + 1}</span><strong>${escapeHTML(scene.label)}</strong></div>${statusChip(scene.signal)}</div>
      <div class="retention-metrics">
        <div><span>Average watching</span><strong>${(Number(scene.averageWatchRatio || 0) * 100).toFixed(1)}%</strong></div>
        <div><span>Scene change</span><strong>${Number(scene.changePoints || 0) > 0 ? '+' : ''}${Number(scene.changePoints || 0).toFixed(1)} pts</strong></div>
        <div><span>Relative retention</span><strong>${(Number(scene.averageRelativeRetention || 0) * 100).toFixed(1)}%</strong></div>
        <div><span>Sharpest drop</span><strong>${Number(scene.largestDropPoints || 0).toFixed(1)} pts</strong></div>
      </div>
    </article>`).join('') || empty('The saved curve could not be mapped to a scene timeline.');
}

function retentionChart(snapshot = {}) {
  const points = Array.isArray(snapshot.points) ? snapshot.points : [];
  if (points.length < 2) return empty('This snapshot does not contain enough points for a curve.');
  const width = 1000;
  const height = 280;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxRatio = Math.max(1, Math.min(1.5, Math.max(...points.map(point => Number(point.audienceWatchRatio || 0))) * 1.05));
  const x = ratio => left + Math.max(0, Math.min(1, Number(ratio || 0))) * plotWidth;
  const y = ratio => top + (1 - Math.max(0, Math.min(maxRatio, Number(ratio || 0))) / maxRatio) * plotHeight;
  const line = points.map(point => `${x(point.elapsedRatio).toFixed(1)},${y(point.audienceWatchRatio).toFixed(1)}`).join(' ');
  const duration = Math.max(1, Number(snapshot.durationSeconds || 1));
  const sceneBands = (snapshot.sceneMetrics || []).map((scene, index) => {
    const start = x(Number(scene.startSeconds || 0) / duration);
    const end = x(Number(scene.endSeconds || 0) / duration);
    return `<g><rect x="${start.toFixed(1)}" y="${top}" width="${Math.max(1, end - start).toFixed(1)}" height="${plotHeight}" class="retention-band band-${index % 2}"/><line x1="${start.toFixed(1)}" y1="${top}" x2="${start.toFixed(1)}" y2="${top + plotHeight}" class="scene-boundary"/><title>${escapeHTML(scene.label)}</title></g>`;
  }).join('');
  const grid = [0.25, 0.5, 0.75, 1].map(value => {
    const lineY = y(value);
    return `<line x1="${left}" y1="${lineY.toFixed(1)}" x2="${width - right}" y2="${lineY.toFixed(1)}" class="retention-grid-line"/><text x="${left - 8}" y="${(lineY + 4).toFixed(1)}" text-anchor="end">${Math.round(value * 100)}%</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="retention-chart-title retention-chart-desc">
    <title id="retention-chart-title">Audience retention for ${escapeHTML(snapshot.title || snapshot.videoId)}</title>
    <desc id="retention-chart-desc">A ${points.length}-point audience retention curve divided by ${snapshot.sceneMetrics?.length || 0} production scenes.</desc>
    ${sceneBands}${grid}
    <polyline points="${line}" class="retention-line"/>
    <text x="${left}" y="${height - 10}" text-anchor="start">Start</text>
    <text x="${width - right}" y="${height - 10}" text-anchor="end">End</text>
  </svg>`;
}

function renderActivation(activation = {}) {
  const container = $('#activation-list');
  if (!container) return;
  const milestones = activation.milestones || {};
  const rows = [
    ['Setup ready', milestones.setupReady],
    ['First real MP4', milestones.firstRealVideo],
    ['First approval', milestones.firstApproval],
    ['First YouTube publish', milestones.firstPublish],
    ['Second real MP4', milestones.secondRealVideo]
  ];
  container.innerHTML = rows.map(([name, milestone = {}]) => `
    <div class="timeline-item">
      <div class="timeline-dot ${milestone.achieved ? 'done' : ''}"></div>
      <div><strong>${escapeHTML(name)}</strong><div class="meta-line">${milestone.achieved ? escapeHTML(formatDate(milestone.at)) : 'Not reached yet'}</div></div>
    </div>`).join('');
  if (milestones.firstRealVideo?.achieved) {
    container.insertAdjacentHTML('beforeend', `
      <div class="activation-share">
        <span>Made something real with Lumen?</span>
        <a class="button secondary small" href="https://github.com/darkzOGx/youtube-automation-agent/discussions/new?category=show-and-tell" target="_blank" rel="noreferrer">Share what you built</a>
      </div>`);
  }
}

function renderOperator(strategy, runs, system) {
  const form = $('#strategy-form');
  const mapping = strategy ? {
    objective: strategy.objective,
    audience: strategy.audience,
    valueProposition: strategy.value_proposition,
    contentPillars: (strategy.contentPillars || []).join(', '),
    cadencePerWeek: strategy.cadence_per_week,
    videosPerRun: strategy.videos_per_run,
    defaultFormat: strategy.default_format,
    defaultLength: strategy.default_length,
    successMetric: strategy.success_metric,
    constraints: strategy.constraints
  } : {};
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value ?? '';
  }

  const strategyStatus = strategy?.status || 'not_configured';
  $('#operator-strategy-status').className = `status ${escapeHTML(strategyStatus)}`;
  $('#operator-strategy-status').textContent = label(strategyStatus);
  const run = runs[0];
  const active = run && ['queued', 'running', 'cancelling'].includes(run.status);
  const recoverable = run && ['failed', 'interrupted', 'completed_with_issues'].includes(run.status);
  $('#activate-operator-button').disabled = Boolean(system.setupRequired || active || system.readiness?.status === 'failed');
  $('#activate-operator-button').title = system.readiness?.status === 'failed' ? 'Resolve the pipeline health failures first' : '';
  $('#activate-operator-button').textContent = strategy?.status === 'active' ? 'Run strategy now' : 'Activate & run now';
  $('#pause-operator-button').classList.toggle('hidden', strategy?.status !== 'active');
  $('#cancel-operator-run').classList.toggle('hidden', !active);
  if (active) $('#cancel-operator-run').dataset.runId = run.id;
  $('#resume-operator-run').classList.toggle('hidden', !recoverable);
  $('#resume-operator-run').disabled = Boolean(system.setupRequired || system.readiness?.status === 'failed');
  if (recoverable) $('#resume-operator-run').dataset.runId = run.id;

  if (!run) {
    $('#operator-run-title').textContent = 'Waiting for a strategy';
    $('#operator-run-summary').innerHTML = empty('Save a channel mandate, then activate it to research and produce the first plan.');
    $('#operator-plan').innerHTML = empty('No editorial plan yet.');
    return;
  }

  $('#operator-run-title').textContent = `${label(run.stage)} · ${run.progress || 0}%`;
  const sources = Array.isArray(run.research?.sources) ? run.research.sources.join(', ') : 'Research pending';
  $('#operator-run-summary').innerHTML = `<div class="run-summary">
    <div class="progress"><i style="width:${Math.max(0, Math.min(100, run.progress || 0))}%"></i></div>
    <div class="run-summary-row"><span>Status</span><strong>${statusChip(run.status)}</strong></div>
    <div class="run-summary-row"><span>Research</span><strong>${escapeHTML(sources)}</strong></div>
    <div class="run-summary-row"><span>Produced</span><strong>${escapeHTML(run.summary?.generated || 0)} / ${escapeHTML(run.summary?.planned || run.plan?.length || 0)}</strong></div>
    <div class="run-summary-row"><span>Needs review</span><strong>${escapeHTML(run.summary?.needsReview || 0)}</strong></div>
    ${run.error ? `<p class="callout">${escapeHTML(run.error)}</p>` : ''}
  </div>`;
  const plan = Array.isArray(run.plan) ? run.plan : [];
  $('#operator-plan').innerHTML = plan.length ? plan.map((item, index) => {
    const job = (run.generatedJobs || []).find(candidate => candidate.topic === item.topic);
    return `<article class="plan-card">
      <div class="meta-line">${index + 1} · ${escapeHTML(item.format)} · ${escapeHTML(item.length)} ${job ? `· ${statusChip(job.reviewStatus || job.status)}` : ''}</div>
      <strong>${escapeHTML(item.topic)}</strong>
      <p>${escapeHTML(item.angle || item.rationale)}</p>
    </article>`;
  }).join('') : empty('Research and planning will appear here when the run begins.');
}

function populateSettings(profile = {}, settings = {}, providers = []) {
  const form = $('#profile-form');
  const mapping = {
    channelName: profile.channel_name,
    goal: profile.goal,
    targetAudience: profile.target_audience,
    brandVoice: profile.brand_voice,
    defaultStyle: profile.default_style,
    callToAction: profile.call_to_action,
    visualStyle: profile.visual_style,
    timezone: profile.timezone,
    bannedTopics: (profile.bannedTopics || []).join(', ')
  };
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value || '';
  }
  $('#approval-required').checked = settings.approval_required !== 'false';
  $('#notifications-enabled').checked = settings.notification_enabled !== 'false';
  const videoMapping = {
    videoProvider: settings.video_provider || 'slideshow',
    videoEngine: settings.video_engine || 'standard',
    videoGenerationMode: settings.video_generation_mode || 'hybrid',
    videoClipDuration: settings.video_clip_duration || '8',
    videoMaxGeneratedSeconds: settings.video_max_generated_seconds || '60'
  };
  for (const [name, value] of Object.entries(videoMapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value;
  }
  const selected = providers.find(provider => provider.id === videoMapping.videoProvider);
  $('#video-provider-status').textContent = videoMapping.videoProvider === 'auto'
    ? `${providers.filter(provider => provider.available && provider.id !== 'slideshow').length} paid provider(s) available; local slideshow remains the final fallback.`
    : videoMapping.videoProvider === 'slideshow' ? 'Local FFmpeg slideshow is selected; no external video credentials are required.'
      : selected?.available ? `${label(selected.id)} is configured (${selected.model}).` : `${label(videoMapping.videoProvider)} credentials are not configured.`;
}

function switchView(view) {
  ui.currentView = view;
  const titles = { overview: 'Overview', pipeline: 'Content pipeline', campaign: 'Campaign Clip Builder', calendar: 'Calendar & ideas', operator: 'Niche & ideas', readiness: 'Pipeline health', analytics: 'Analytics', settings: 'Channel setup' };
  const workspaceTitle = $('#workspace-view-title');
  if (workspaceTitle) workspaceTitle.textContent = view === 'overview' ? ui.overviewStatus : titles[view] || 'Overview';
  if (ui.state) renderLiveStageBar(ui.state.jobs || [], ui.state.pipeline || []);
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`));
  location.hash = view;
}

function selectOptions(options, selected) {
  return options.map(([value, label]) =>
    `<option value="${escapeHTML(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(label)}</option>`
  ).join('');
}

function renderSourceEditor(source = {}, disabled = false) {
  return `<article class="provenance-item" data-provenance-source data-id="${escapeHTML(source.id || '')}" data-published-at="${escapeHTML(source.publishedAt || '')}" data-accessed-at="${escapeHTML(source.accessedAt || '')}">
    <div class="provenance-item-heading"><strong>Research source</strong><button type="button" class="text-button danger-text" data-remove-provenance ${disabled ? 'disabled' : ''}>Remove</button></div>
    <label><span>URL</span><input data-field="url" type="url" value="${escapeHTML(source.url || '')}" placeholder="https://..." required ${disabled ? 'disabled' : ''}></label>
    <div class="form-grid two">
      <label><span>Title</span><input data-field="title" value="${escapeHTML(source.title || '')}" maxlength="300" ${disabled ? 'disabled' : ''}></label>
      <label><span>Publisher</span><input data-field="publisher" value="${escapeHTML(source.publisher || '')}" maxlength="200" ${disabled ? 'disabled' : ''}></label>
      <label><span>Type</span><select data-field="sourceType" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['official', 'Official source'], ['article', 'Article'], ['video', 'Video'], ['dataset', 'Dataset'], ['asset', 'Asset or license'], ['other', 'Other']
      ], source.sourceType || 'other')}</select></label>
      <label><span>Review status</span><select data-field="status" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['pending', 'Pending review'], ['verified', 'Verified'], ['rejected', 'Rejected']
      ], source.status || 'pending')}</select></label>
    </div>
    <label><span>Evidence notes</span><textarea data-field="notes" rows="2" maxlength="1000" ${disabled ? 'disabled' : ''}>${escapeHTML(source.notes || '')}</textarea></label>
    ${source.url ? `<a class="source-link" href="${escapeHTML(source.url)}" target="_blank" rel="noopener">Open source ↗</a>` : ''}
  </article>`;
}

function renderClaimEditor(claim = {}, sources = [], disabled = false) {
  const linked = new Set(claim.sourceIds || []);
  return `<article class="provenance-item ${claim.riskLevel === 'high' ? 'high-risk' : ''}" data-provenance-claim data-id="${escapeHTML(claim.id || '')}">
    <div class="provenance-item-heading"><strong>Factual claim</strong><button type="button" class="text-button danger-text" data-remove-provenance ${disabled ? 'disabled' : ''}>Remove</button></div>
    <label><span>Claim</span><textarea data-field="text" rows="3" maxlength="1000" required ${disabled ? 'disabled' : ''}>${escapeHTML(claim.text || '')}</textarea></label>
    <div class="form-grid two">
      <label><span>Risk</span><select data-field="riskLevel" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['standard', 'Standard'], ['high', 'High risk']
      ], claim.riskLevel || 'standard')}</select></label>
      <label><span>Resolution</span><select data-field="status" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['pending', 'Pending'], ['supported', 'Supported'], ['unsupported', 'Unsupported'], ['waived', 'Waived with note']
      ], claim.status || 'pending')}</select></label>
    </div>
    <fieldset class="source-checklist" ${disabled ? 'disabled' : ''}><legend>Supporting sources</legend>
      ${sources.length ? sources.map(source => `<label><input type="checkbox" data-claim-source="${escapeHTML(source.id)}" ${linked.has(source.id) ? 'checked' : ''}> ${escapeHTML(source.title || source.url)}</label>`).join('') : '<small>Add a source before marking this claim supported.</small>'}
    </fieldset>
    <label><span>Reviewer notes</span><textarea data-field="notes" rows="2" maxlength="1000" placeholder="Required when waived" ${disabled ? 'disabled' : ''}>${escapeHTML(claim.notes || '')}</textarea></label>
  </article>`;
}

function renderProvenanceEditor(provenance = {}, canReview = true) {
  const sources = provenance.sources || [];
  const claims = provenance.claims || [];
  const summary = provenance.summary || {};
  const statusLabel = provenance.status === 'verified' ? 'Evidence verified' : provenance.status === 'not_required' ? 'No claims declared' : `${summary.unresolvedClaims || 0} unresolved`;
  return `<section class="provenance-panel">
    <div class="panel-heading"><div><p class="eyebrow">RESEARCH &amp; PROVENANCE</p><h3>Evidence desk</h3><p>Verify sources, connect every factual claim, and record disclosure before approval.</p></div><span class="status ${provenance.status === 'verified' || provenance.status === 'not_required' ? 'success' : 'warning'}">${escapeHTML(statusLabel)}</span></div>
    <div class="provenance-toolbar"><strong>Sources</strong>${canReview ? '<button type="button" class="text-button" data-add-provenance-source>Add source +</button>' : ''}</div>
    <div id="provenance-sources" class="provenance-list">${sources.map(source => renderSourceEditor(source, !canReview)).join('') || '<p class="empty-inline">No research sources attached.</p>'}</div>
    <div class="provenance-toolbar"><strong>Claims</strong>${canReview ? '<button type="button" class="text-button" data-add-provenance-claim>Add claim +</button>' : ''}</div>
    <div id="provenance-claims" class="provenance-list">${claims.map(claim => renderClaimEditor(claim, sources, !canReview)).join('') || '<p class="empty-inline">No externally verifiable claims declared.</p>'}</div>
    <label class="toggle disclosure-toggle"><input id="contains-synthetic-media" type="checkbox" ${provenance.containsSyntheticMedia ? 'checked' : ''} ${canReview ? '' : 'disabled'}><span></span> Contains realistic altered or synthetic media requiring YouTube disclosure</label>
    ${canReview ? '<button type="button" class="button secondary" data-save-provenance>Save evidence review</button>' : ''}
  </section>`;
}

function renderSceneEditor(item, canReview = true) {
  const scenes = item.scenes || [];
  if (!scenes.length) return '';
  const verifiedSources = (item.provenance?.sources || []).filter(source => source.status === 'verified');
  const audio = item.assets?.audio || {};
  const intentionalSilence = audio.intentionalSilence === true;
  const narrationIssues = scenes.filter(scene => !['current', 'intentional_silence'].includes(scene.narrationStatus)).length;
  return `<section class="scene-repair-panel">
    <div class="panel-heading scene-heading">
      <div><p class="eyebrow">SCENE REPAIR STUDIO</p><h3>Repair the timeline, not the whole video</h3><p>Edit, replace, or regenerate one scene. Changes remain draft-only until the timeline is rebuilt and approved.</p></div>
      ${canReview ? `<button type="button" class="button primary small" data-rebuild-scenes="${escapeHTML(item.id)}">Rebuild final video</button>` : ''}
    </div>
    <div class="narration-recovery ${intentionalSilence ? 'intentional' : narrationIssues ? 'attention' : ''}">
      <div><p class="eyebrow">NARRATION RELIABILITY</p><strong>${intentionalSilence ? 'Intentional silence confirmed' : narrationIssues ? `${narrationIssues} scene${narrationIssues === 1 ? '' : 's'} need narration` : 'Narration evidence is current'}</strong>
      <p>${intentionalSilence ? escapeHTML(audio.silenceReason || '') : audio.error ? escapeHTML(audio.error) : 'Regenerate narration without replacing the scene visual. Approval remains blocked until audio is ready.'}</p>
      ${audio.provider ? `<span class="narration-evidence">${escapeHTML(audio.provider)}${audio.model ? ` · ${escapeHTML(audio.model)}` : ''}${audio.externalTaskId ? ` · task ${escapeHTML(audio.externalTaskId)}` : ''}</span>` : ''}</div>
      ${canReview ? intentionalSilence
        ? '<button type="button" class="button secondary small" data-require-narration>Require narration</button>'
        : '<button type="button" class="button secondary small" data-intentional-silence>Use intentional silence</button>' : ''}
    </div>
    <div class="scene-summary"><strong>${scenes.length} scenes</strong><span>${Math.round(scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0))}s timeline</span><span>${scenes.filter(scene => scene.status !== 'ready').length} pending repairs</span></div>
    <div class="scene-list">
      ${scenes.map((scene, index) => {
        const disabled = !canReview || scene.locked;
        const sourceIds = new Set(scene.provenanceSourceIds || []);
        const preview = scene.assetUrl
          ? scene.assetType === 'video'
            ? `<video controls preload="metadata"><source src="${escapeHTML(scene.assetUrl)}"></video>`
            : `<img src="${escapeHTML(scene.assetUrl)}" alt="${escapeHTML(scene.label)} scene asset">`
          : '<div class="preview-placeholder">No scene asset</div>';
        return `<article class="scene-card ${scene.locked ? 'locked' : ''}" data-scene-card="${escapeHTML(scene.id)}">
          <div class="scene-card-top">
            <div class="scene-preview">${preview}<span class="scene-number">${index + 1}</span></div>
            <div class="scene-identity">
              <div class="scene-status-row">${statusChip(scene.status)} ${statusChip(`narration_${scene.narrationStatus || 'unavailable'}`)}<span>r${scene.revision}</span></div>
              <label><span>Scene label</span><input data-scene-field="label" maxlength="120" value="${escapeHTML(scene.label)}" ${disabled ? 'disabled' : ''}></label>
              <label><span>Duration</span><input data-scene-field="duration" type="number" min="2" max="600" step="0.5" value="${escapeHTML(scene.duration)}" ${disabled ? 'disabled' : ''}></label>
            </div>
          </div>
          <label><span>Narration</span><textarea data-scene-field="scriptText" rows="4" maxlength="10000" ${disabled ? 'disabled' : ''}>${escapeHTML(scene.scriptText)}</textarea></label>
          <label><span>Visual prompt</span><textarea data-scene-field="prompt" rows="3" maxlength="2000" ${disabled ? 'disabled' : ''}>${escapeHTML(scene.prompt)}</textarea></label>
          ${verifiedSources.length ? `<fieldset class="source-checklist scene-sources" ${disabled ? 'disabled' : ''}><legend>Verified evidence linked to this narration</legend>${verifiedSources.map(source => `<label><input type="checkbox" data-scene-source value="${escapeHTML(source.id)}" ${sourceIds.has(source.id) ? 'checked' : ''}> ${escapeHTML(source.title)}</label>`).join('')}</fieldset>` : ''}
          <div class="scene-options">
            <label class="toggle"><input type="checkbox" data-scene-factual checked ${disabled ? 'disabled' : ''}><span></span> Narration changes may contain factual claims</label>
            <span>Visual: ${escapeHTML(scene.provider || 'local')} ${scene.model ? `· ${escapeHTML(scene.model)}` : ''}</span>
          </div>
          <div class="scene-narration-evidence"><span>Narration: ${escapeHTML(scene.narrationProvider || 'not generated')}${scene.narrationModel ? ` · ${escapeHTML(scene.narrationModel)}` : ''}${scene.narrationTaskId ? ` · task ${escapeHTML(scene.narrationTaskId)}` : ''}</span>${scene.narrationError ? `<span class="danger-text">${escapeHTML(scene.narrationError)}</span>` : ''}</div>
          ${canReview ? `<div class="scene-actions">
            <button type="button" class="text-button" data-scene-move="up" ${disabled || index === 0 ? 'disabled' : ''}>↑ Earlier</button>
            <button type="button" class="text-button" data-scene-move="down" ${disabled || index === scenes.length - 1 ? 'disabled' : ''}>↓ Later</button>
            <button type="button" class="text-button approve" data-scene-save ${disabled ? 'disabled' : ''}>Save scene</button>
            <button type="button" class="text-button" data-scene-narration ${disabled ? 'disabled' : ''}>Regenerate narration only</button>
            <button type="button" class="text-button" data-scene-regenerate ${disabled ? 'disabled' : ''}>Regenerate scene</button>
            <label class="text-button upload-button ${disabled ? 'disabled' : ''}">Replace asset<input type="file" data-scene-upload accept="image/png,image/jpeg,image/webp,video/mp4" ${disabled ? 'disabled' : ''}></label>
            <button type="button" class="text-button" data-scene-lock>${scene.locked ? 'Unlock' : 'Lock'}</button>
          </div>` : ''}
        </article>`;
      }).join('')}
    </div>
  </section>`;
}

function renderShortsStudio(item) {
  if (!item.assets?.finalVideo?.path || item.assets.finalVideo.simulated) return '';
  const clips = item.shorts || [];
  const parentApproved = item.review_status === 'approved';
  return `<section class="shorts-studio">
    <div class="panel-heading shorts-heading">
      <div><p class="eyebrow">SHORTS REPURPOSING STUDIO</p><h3>Turn one production into vertical reach</h3><p>Create local 9:16 excerpts with mobile captions. Drafts inherit the source production's evidence and still require separate approval.</p></div>
      <button type="button" class="button secondary small" data-propose-shorts="${escapeHTML(item.id)}">${clips.length ? 'Refresh drafts' : 'Create 3 Short drafts'}</button>
    </div>
    <div class="shorts-evidence ${parentApproved ? 'ready' : ''}">
      <span>${parentApproved ? '✓ Source production approved' : 'Source approval required before scheduling'}</span>
      <span>${escapeHTML(item.provenance?.status === 'verified' ? 'Evidence verified' : item.provenance?.status === 'not_required' ? 'No factual claims declared' : 'Evidence review incomplete')}</span>
      <span>Local render · no new provider call</span>
    </div>
    ${clips.length ? `<div class="shorts-grid">${clips.map(clip => {
      const locked = ['scheduled', 'uploading', 'published', 'reconciliation_required'].includes(clip.status);
      const rendered = Boolean(clip.assetUrls?.video);
      return `<article class="short-card" data-short-card="${escapeHTML(clip.id)}">
        <div class="short-preview">${rendered
          ? `<video controls preload="metadata"><source src="${escapeHTML(clip.assetUrls.video)}" type="video/mp4"></video>`
          : `<div class="short-placeholder"><strong>9:16</strong><span>${escapeHTML(label(clip.layout))} layout</span></div>`}</div>
        <div class="short-editor">
          <div class="scene-status-row">${statusChip(clip.status)}<span>${Number(clip.duration || 0).toFixed(0)}s</span><span>${escapeHTML((clip.sourceSceneLabels || []).join(' + '))}</span></div>
          <label><span>Short title</span><input data-short-field="title" maxlength="100" value="${escapeHTML(clip.title)}" ${locked ? 'disabled' : ''}></label>
          <label><span>Description and parent-video CTA</span><textarea data-short-field="description" rows="3" maxlength="5000" ${locked ? 'disabled' : ''}>${escapeHTML(clip.description)}</textarea></label>
          <label><span>Tags</span><input data-short-field="tags" value="${escapeHTML((clip.tags || []).join(', '))}" ${locked ? 'disabled' : ''}></label>
          <div class="form-grid two">
            <label><span>Vertical layout</span><select data-short-field="layout" ${locked ? 'disabled' : ''}><option value="blur" ${clip.layout === 'blur' ? 'selected' : ''}>Blurred canvas</option><option value="crop" ${clip.layout === 'crop' ? 'selected' : ''}>Center crop</option><option value="stacked" ${clip.layout === 'stacked' ? 'selected' : ''}>Stacked focus</option></select></label>
            <label><span>Publish time</span><input data-short-field="publishTime" type="datetime-local" value="${toLocalInput(clip.publishTime)}" ${locked ? 'disabled' : ''}></label>
            <label><span>Privacy</span><select data-short-field="privacyStatus" ${locked ? 'disabled' : ''}><option value="private" ${clip.privacyStatus === 'private' ? 'selected' : ''}>Private</option><option value="unlisted" ${clip.privacyStatus === 'unlisted' ? 'selected' : ''}>Unlisted</option><option value="public" ${clip.privacyStatus === 'public' ? 'selected' : ''}>Public</option></select></label>
          </div>
          <p class="short-rationale">${escapeHTML(clip.rationale || '')}${clip.error ? `<br><span class="danger-text">${escapeHTML(clip.error)}</span>` : ''}</p>
          ${clip.youtubeUrl ? `<a class="source-link" href="${escapeHTML(clip.youtubeUrl)}" target="_blank" rel="noopener">Open published Short ↗</a>` : ''}
          ${!locked ? `<div class="short-actions"><button type="button" class="text-button" data-short-save>Save draft</button><button type="button" class="button secondary small" data-short-render>${rendered ? 'Render again' : 'Render 9:16'}</button><button type="button" class="button primary small" data-short-approve ${!parentApproved || clip.status !== 'rendered' ? 'disabled' : ''} title="${!parentApproved ? 'Approve the source production first' : clip.status !== 'rendered' ? 'Render this Short first' : 'Confirm and schedule this Short'}">Approve &amp; schedule</button></div>` : ''}
        </div>
      </article>`;
    }).join('')}</div>` : '<p class="empty-inline">No Short drafts yet. Create three candidates from the current scene timeline without calling a paid provider.</p>'}
  </section>`;
}


function setupPreviewPlayer() {
  const player = $('#production-preview-player');
  if (!player) return;
  const formatTime = value => {
    if (!Number.isFinite(value)) return '0:00';
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const update = () => {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const progress = duration ? (player.currentTime / duration) * 100 : 0;
    const progressBar = $('#preview-progress-bar');
    if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    const current = document.querySelector('[data-preview-current-time]');
    const total = document.querySelector('[data-preview-duration]');
    const playButton = document.querySelector('[data-preview-play]');
    if (current) current.textContent = formatTime(player.currentTime);
    if (total) total.textContent = formatTime(duration);
    if (playButton) playButton.textContent = player.paused ? 'Play' : 'Pause';
  };
  player.addEventListener('loadedmetadata', update);
  player.addEventListener('timeupdate', update);
  player.addEventListener('play', update);
  player.addEventListener('pause', update);
  document.querySelector('[data-preview-volume]')?.addEventListener('input', event => {
    player.volume = Number(event.target.value);
  });
  document.querySelector('[data-preview-speed]')?.addEventListener('change', event => {
    player.playbackRate = Number(event.target.value);
  });
  document.querySelector('.timeline-track')?.addEventListener('click', event => {
    if (!player.duration) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    player.currentTime = ((event.clientX - bounds.left) / bounds.width) * player.duration;
  });
  update();
}
async function openContent(productionId) {
  $('#loading').classList.add('active');
  try {
    const item = await api(`/api/content/${encodeURIComponent(productionId)}`);
    const data = item.editorData || {};
    const title = data.title || item.seo?.title || item.script?.title || item.strategy?.topic || 'Untitled content';
    const description = data.description || item.seo?.description || '';
    const tags = data.tags || item.seo?.tags || [];
    const publishTime = data.publishTime || item.schedule?.publish_time || item.scheduled_publish_time;
    const canReview = !['published'].includes(item.schedule?.status);
    const experiment = data.packagingExperiment;
    const selectedTitleVariant = Number(data.selectedTitleVariant || 0);
    const selectedThumbnailVariant = Number(data.selectedThumbnailVariant || 0);
    const scenes = Array.isArray(item.scenes) ? item.scenes : [];
    const sceneDuration = scenes.length ? scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0) : Number(item.duration || 0) || 0;
    const previewVideo = item.assetUrls.video || '';
    const previewPoster = item.assetUrls.thumbnail || '';
    const currentScene = scenes[0] || { label: 'Opening scene', duration: 0 };
    const sceneMarkers = scenes.length
      ? scenes.map((scene, index) => {
          const startOffset = scenes.slice(0, index).reduce((sum, entry) => sum + Number(entry.duration || 0), 0);
          const offsetPercent = sceneDuration ? (startOffset / sceneDuration) * 100 : 0;
          const sceneLabel = scene.label || `Scene ${index + 1}`;
          return `<button type="button" class="scene-marker ${index === 0 ? 'active' : ''}" data-scene-jump="${escapeHTML(scene.id || `scene-${index + 1}`)}" data-scene-label="${escapeHTML(sceneLabel)}" data-scene-start="${Number(startOffset).toFixed(2)}" data-scene-progress="${Number(offsetPercent).toFixed(2)}" style="left:${offsetPercent}%">${index + 1}</button>`;
        }).join('')
      : '<span class="scene-marker empty">No scene markers yet</span>';
    $('#content-detail').innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">CONTENT REVIEW</p><h2>${escapeHTML(title)}</h2><div class="meta-line">${statusChip(item.schedule?.status || item.review_status || item.status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div><button type="button" class="close-button" data-close>×</button></div>
      <form id="content-review-form" class="editor content-review-editor">
        <div class="content-layout">
          <div>
            <div class="production-preview-workspace">
              <div class="preview-media-panel">
                <div class="preview-header">
                  <div>
                    <p class="eyebrow">PRODUCTION PREVIEW WORKSPACE</p>
                    <h3>${escapeHTML(title)}</h3>
                  </div>
                  <div class="preview-actions">
                    <button type="button" class="button secondary small preview-action-icon" data-preview-toggle-captions aria-label="Toggle captions" aria-pressed="true" title="Toggle captions">CC</button>
                    <button type="button" class="button secondary small preview-action-icon" data-preview-export aria-label="${previewVideo ? 'Download video' : 'Export pending'}" ${previewVideo ? 'title="Download video"' : 'disabled title="Rebuild the final video before exporting"'}><span aria-hidden="true">⇩</span></button>
                  </div>
                </div>
                <div class="preview-video-shell">
                  ${previewVideo
                    ? `<video id="production-preview-player" preload="metadata" poster="${previewPoster}" data-captions="on"><source src="${previewVideo}" type="video/mp4"></video>`
                    : previewPoster
                      ? `<img src="${previewPoster}" alt="Generated thumbnail">`
                      : '<div class="preview-placeholder">No playable preview was produced.</div>'}
                  ${previewVideo ? '<button type="button" class="preview-play-overlay" data-preview-play aria-label="Play video">▶</button>' : ''}
                  <div class="preview-scene-badge">Current scene: <strong>${escapeHTML(currentScene.label || 'Opening scene')}</strong></div>
                </div>
                ${previewVideo ? `<div class="preview-controls" aria-label="Video controls">
                  <button type="button" class="player-control player-play" data-preview-play aria-label="Play video">▶</button>
                  <button type="button" class="player-control" data-preview-skip="-10" aria-label="Skip back 10 seconds">-10s</button>
                  <button type="button" class="player-control" data-preview-skip="10" aria-label="Skip forward 10 seconds">+10s</button>
                  <span class="preview-time"><strong data-preview-current-time>0:00</strong> / <span data-preview-duration>0:00</span></span>
                  <input class="preview-volume" data-preview-volume type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
                  <select class="preview-speed" data-preview-speed aria-label="Playback speed"><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select>
                  <button type="button" class="player-control preview-fullscreen" data-preview-fullscreen aria-label="Enter fullscreen" title="Fullscreen">⛶</button>
                </div>` : ''}
                <div class="timeline-progress" aria-label="Video timeline">
                  <div class="timeline-track"><span id="preview-progress-bar" style="width:0%"></span></div>
                  <div class="scene-markers">${sceneMarkers}</div>
                </div>
              </div>
            </div>
            <div class="quality-grid">${(item.qualityChecks || []).map(check => `<div class="quality-check ${check.passed ? 'pass' : 'fail'}">${check.passed ? '✓' : '×'} ${escapeHTML(check.message)}</div>`).join('') || '<div class="quality-check">No quality results recorded.</div>'}</div>
            ${item.review_notes ? `<p class="callout">${escapeHTML(item.review_notes)}</p>` : ''}
          </div>
          <div class="editor">
            <label><span>Title</span><input name="title" maxlength="100" value="${escapeHTML(title)}" required></label>
            <label><span>Description</span><textarea name="description" rows="7">${escapeHTML(description)}</textarea></label>
            <label><span>Tags</span><input name="tags" value="${escapeHTML(tags.join(', '))}"></label>
            ${experiment ? `<section class="experiment-panel">
              <div><p class="eyebrow">APPROVED LEARNING EXPERIMENT</p><strong>${escapeHTML(experiment.hypothesis)}</strong><p>Choose the packaging to ship. Nothing changes on YouTube until this content is approved and published.</p></div>
              <label><span>Title variant</span><select name="selectedTitleVariant">${experiment.titleVariants.map((variant, index) => `<option value="${index}" data-title="${escapeHTML(variant.title)}" ${index === selectedTitleVariant ? 'selected' : ''}>${escapeHTML(variant.label)} — ${escapeHTML(variant.title)}</option>`).join('')}</select></label>
              <div class="experiment-thumbnails">${experiment.thumbnailVariants.map((variant, index) => `<label class="experiment-thumb ${index === selectedThumbnailVariant ? 'selected' : ''}"><input type="radio" name="selectedThumbnailVariant" value="${index}" ${index === selectedThumbnailVariant ? 'checked' : ''}><img src="${escapeHTML(item.assetUrls.experimentThumbnails?.[index] || '')}" alt="${escapeHTML(variant.label)} thumbnail variant"><span>${escapeHTML(variant.label)}</span></label>`).join('')}</div>
            </section>` : ''}
          </div>
        </div>
        <section class="review-decision-panel">
          <div class="panel-heading"><div><p class="eyebrow">NEXT DECISION</p><h3>Review and publish</h3><p>Confirm the packaging, rights, facts, and timing before scheduling.</p></div></div>
          <div class="form-grid two">
            <label><span>Publish time</span><input name="publishTime" type="datetime-local" value="${toLocalInput(publishTime)}"></label>
            <label><span>Privacy</span><select name="privacyStatus"><option value="private" ${data.privacyStatus === 'private' ? 'selected' : ''}>Private</option><option value="unlisted" ${data.privacyStatus === 'unlisted' ? 'selected' : ''}>Unlisted</option><option value="public" ${data.privacyStatus === 'public' ? 'selected' : ''}>Public</option></select></label>
          </div>
          <div class="settings-row">
            <label class="toggle"><input name="factChecked" type="checkbox" ${data.factChecked ? 'checked' : ''}><span></span> Facts and claims reviewed</label>
            <label class="toggle"><input name="rightsConfirmed" type="checkbox" ${data.rightsConfirmed ? 'checked' : ''}><span></span> Media rights confirmed</label>
          </div>
          ${canReview ? `<div class="form-actions"><button type="button" class="button primary" data-approve-content="${escapeHTML(item.id)}">Approve & schedule</button><button type="button" class="button secondary" data-save-content="${escapeHTML(item.id)}">Save draft</button><button type="button" class="button danger" data-reject-content="${escapeHTML(item.id)}">Reject</button><button type="button" class="button ghost" data-retry-content="${escapeHTML(item.id)}">Regenerate</button></div>` : `<a class="button secondary" href="${escapeHTML(item.schedule?.youtube_url || '#')}" target="_blank" rel="noopener">Open on YouTube</a>`}
        </section>
        ${renderSceneEditor(item, canReview)}
        ${renderShortsStudio(item)}
        ${renderProvenanceEditor(item.provenance, canReview)}
      </form>`;
    $('#content-review-form').dataset.productionId = item.id;
    $('#content-dialog').showModal();
    setupPreviewPlayer();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return escapeHTML(new Date(date.getTime() - offset).toISOString().slice(0, 16));
}

function contentFormData() {
  const form = $('#content-review-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    title: values.title,
    description: values.description,
    tags: values.tags,
    publishTime: values.publishTime ? new Date(values.publishTime).toISOString() : undefined,
    privacyStatus: values.privacyStatus,
    selectedTitleVariant: values.selectedTitleVariant,
    selectedThumbnailVariant: values.selectedThumbnailVariant,
    factChecked: form.elements.factChecked?.checked || false,
    rightsConfirmed: form.elements.rightsConfirmed?.checked || false
  };
}

function sceneFormData(card) {
  return {
    label: card.querySelector('[data-scene-field="label"]').value,
    duration: Number(card.querySelector('[data-scene-field="duration"]').value),
    scriptText: card.querySelector('[data-scene-field="scriptText"]').value,
    prompt: card.querySelector('[data-scene-field="prompt"]').value,
    provenanceSourceIds: Array.from(card.querySelectorAll('[data-scene-source]:checked')).map(input => input.value),
    factualChange: card.querySelector('[data-scene-factual]')?.checked !== false
  };
}

function shortFormData(card) {
  const publishTime = card.querySelector('[data-short-field="publishTime"]')?.value;
  return {
    title: card.querySelector('[data-short-field="title"]')?.value,
    description: card.querySelector('[data-short-field="description"]')?.value,
    tags: card.querySelector('[data-short-field="tags"]')?.value,
    layout: card.querySelector('[data-short-field="layout"]')?.value,
    publishTime: publishTime ? new Date(publishTime).toISOString() : undefined,
    privacyStatus: card.querySelector('[data-short-field="privacyStatus"]')?.value
  };
}

async function refreshContentDialog(productionId, message) {
  if (message) showToast(message);
  if ($('#content-dialog').open) $('#content-dialog').close();
  await refreshDashboard(true);
  await openContent(productionId);
}

async function uploadSceneAsset(productionId, sceneId, file) {
  if (!confirm('Confirm you own or have permission to use this replacement asset.')) return;
  const synthetic = confirm('Does this replacement contain realistic altered or synthetic media that should be disclosed to YouTube?');
  $('#loading').classList.add('active');
  try {
    await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/asset`, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type,
        'x-file-name': file.name,
        'x-rights-confirmed': 'true',
        'x-synthetic-media': String(synthetic)
      }
    });
    await refreshContentDialog(productionId, 'Scene asset replaced. Rebuild before approval.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function provenanceFormData() {
  const sources = $$('[data-provenance-source]').map(item => ({
    id: item.dataset.id,
    url: item.querySelector('[data-field="url"]').value,
    title: item.querySelector('[data-field="title"]').value,
    publisher: item.querySelector('[data-field="publisher"]').value,
    sourceType: item.querySelector('[data-field="sourceType"]').value,
    status: item.querySelector('[data-field="status"]').value,
    notes: item.querySelector('[data-field="notes"]').value,
    publishedAt: item.dataset.publishedAt || null,
    accessedAt: item.dataset.accessedAt || null
  }));
  const claims = $$('[data-provenance-claim]').map(item => ({
    id: item.dataset.id,
    text: item.querySelector('[data-field="text"]').value,
    riskLevel: item.querySelector('[data-field="riskLevel"]').value,
    status: item.querySelector('[data-field="status"]').value,
    notes: item.querySelector('[data-field="notes"]').value,
    sourceIds: [...item.querySelectorAll('[data-claim-source]:checked')].map(input => input.dataset.claimSource)
  }));
  return {
    sources,
    claims,
    containsSyntheticMedia: $('#contains-synthetic-media')?.checked || false
  };
}

function clientId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

function currentSourceOptions() {
  return $$('[data-provenance-source]').map(item => ({
    id: item.dataset.id,
    title: item.querySelector('[data-field="title"]').value || item.querySelector('[data-field="url"]').value || 'New source'
  }));
}

async function persistProvenance(productionId, successMessage = null) {
  $('#loading').classList.add('active');
  try {
    const result = await api(`/api/content/${encodeURIComponent(productionId)}/provenance`, {
      method: 'PUT',
      body: JSON.stringify(provenanceFormData())
    });
    if (successMessage) {
      showToast(successMessage);
      $('#content-dialog').close();
      await openContent(productionId);
    }
    return result;
  } catch (error) {
    showToast(error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

async function mutate(url, method, body, successMessage) {
  $('#loading').classList.add('active');
  try {
    const result = await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    showToast(successMessage);
    await refreshDashboard(true);
    return result;
  } catch (error) {
    const failures = error.data?.quality?.blockingFailures;
    showToast(failures ? `${error.message}: ${failures.join(', ')}` : error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

document.addEventListener('click', async event => {
  const useNiche = event.target.closest('[data-use-niche]');
  if (useNiche) {
    const niche = useNiche.dataset.useNiche;
    const strategyForm = $('#strategy-form');
    if (strategyForm) {
      strategyForm.elements.contentPillars.value = niche;
      strategyForm.elements.objective.value = `Help people learn and make progress with ${niche}.`;
      strategyForm.elements.audience.value = `Beginners interested in ${niche}`;
      strategyForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('Direction added below. Review the audience and save when ready.');
    }
    return;
  }

  const templatePreview = event.target.closest('[data-template-preview]');
  if (templatePreview) {
    const templateId = templatePreview.dataset.templatePreview;
    const template = templateCatalog[templateId];
    if (!template) return;
    $('#template-preview-content').innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">TEMPLATE PREVIEW</p><h2>${escapeHTML(template.title)}</h2></div><button type="button" class="close-button" data-close>×</button></div><div class="template-preview-layout"><img class="template-preview-image" src="/assets/youtube-automation-agent.jpg" alt="${escapeHTML(template.title)} representative preview"><div class="template-preview-copy"><p>${escapeHTML(template.description)}</p><div class="template-preview-tags">${template.tags.map(tag => `<span>${escapeHTML(tag)}</span>`).join('')}</div><div class="form-actions"><button type="button" class="button primary" data-template-use="${escapeHTML(templateId)}">Use template</button><button type="button" class="button ghost" data-close>Close</button></div></div></div>`;
    $('#template-preview-dialog').showModal();
    return;
  }

  const templateSave = event.target.closest('[data-template-save]');
  if (templateSave) {
    const templateId = templateSave.dataset.templateSave;
    const template = templateCatalog[templateId];
    if (!template) return;
    const saved = JSON.parse(localStorage.getItem('yaa_template_presets') || '[]');
    if (!saved.some(item => item.id === templateId)) {
      saved.push({ id: templateId, title: template.title, values: generationTemplates[templateId], savedAt: new Date().toISOString() });
      localStorage.setItem('yaa_template_presets', JSON.stringify(saved));
      templateSave.textContent = '★';
      showToast(`${template.title} saved as a local preset.`);
    } else {
      showToast(`${template.title} is already saved.`);
    }
    return;
  }

  const templateUse = event.target.closest('[data-template-use]');
  if (templateUse) {
    const templateId = templateUse.dataset.templateUse;
    const values = generationTemplates[templateId];
    const form = $('#generate-form');
    if (form && values) {
      for (const [name, value] of Object.entries(values)) {
        if (form.elements[name]) form.elements[name].value = value;
      }
      document.querySelectorAll('[data-create-style]').forEach(item => item.classList.toggle('selected', item.dataset.createStyle === values.style));
      updateCreatePreview();
      $('#template-preview-dialog')?.close();
      $('#generate-dialog').showModal();
    }
    return;
  }

  const template = event.target.closest('[data-template]');
  if (template) {
    const form = $('#generate-form');
    const values = generationTemplates[template.dataset.template];
    if (form && values) {
      for (const [name, value] of Object.entries(values)) {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) field.value = value;
      }
      document.querySelectorAll('[data-create-style]').forEach(item => item.classList.toggle('selected', item.dataset.createStyle === values.style));
      updateCreatePreview();
      $('#generate-dialog').showModal();
    }
    return;
  }

  const previewCaptionsToggle = event.target.closest('[data-preview-toggle-captions]');
  if (previewCaptionsToggle) {
    const player = $('#production-preview-player');
    const enabled = !(player?.dataset?.captions === 'on');
    if (player) player.dataset.captions = enabled ? 'on' : 'off';
    previewCaptionsToggle.textContent = 'CC';
    previewCaptionsToggle.setAttribute('aria-pressed', String(enabled));
    previewCaptionsToggle.title = enabled ? 'Captions on' : 'Captions off';
    previewCaptionsToggle.classList.toggle('secondary', !enabled);
    previewCaptionsToggle.classList.toggle('ghost', enabled);
    showToast(enabled ? 'Captions enabled for preview.' : 'Captions turned off for preview.');
    return;
  }

  const previewPlay = event.target.closest('[data-preview-play]');
  if (previewPlay) {
    const player = $('#production-preview-player');
    if (!player) return;
    if (player.paused) await player.play().catch(() => {});
    else player.pause();
    return;
  }

  const previewSkip = event.target.closest('[data-preview-skip]');
  if (previewSkip) {
    const player = $('#production-preview-player');
    if (player) player.currentTime = Math.max(0, Math.min(player.duration || 0, player.currentTime + Number(previewSkip.dataset.previewSkip || 0)));
    return;
  }

  const previewFullscreen = event.target.closest('[data-preview-fullscreen]');
  if (previewFullscreen) {
    const shell = document.querySelector('.preview-video-shell');
    if (shell?.requestFullscreen) shell.requestFullscreen();
    return;
  }

  const previewExport = event.target.closest('[data-preview-export]');
  if (previewExport) {
    const player = $('#production-preview-player');
    const href = player?.currentSrc || player?.dataset?.src || '';
    if (!href) {
      showToast('No downloadable video is available yet.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = href;
    link.download = 'production-preview.mp4';
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Download started.');
    return;
  }

  const sceneJump = event.target.closest('[data-scene-jump]');
  if (sceneJump) {
    const player = $('#production-preview-player');
    const sceneLabel = sceneJump.dataset.sceneLabel || 'Current scene';
    const badge = document.querySelector('.preview-scene-badge strong');
    const progressBar = document.getElementById('preview-progress-bar');
    const startTime = Number(sceneJump.dataset.sceneStart || 0);
    const progressPercent = Number(sceneJump.dataset.sceneProgress || 0);
    if (badge) badge.textContent = sceneLabel;
    if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    if (player) {
      if (Number.isFinite(player.duration) && player.duration > 0) {
        player.currentTime = Math.min(player.duration, startTime);
      } else {
        player.dataset.progress = String(progressPercent);
      }
    }
    document.querySelectorAll('.scene-marker').forEach(marker => marker.classList.toggle('active', marker === sceneJump));
    showToast(`Previewing ${sceneLabel}.`);
    return;
  }

  const nav = event.target.closest('[data-view]');
  if (nav) return switchView(nav.dataset.view);
  const go = event.target.closest('[data-go]');
  if (go) return switchView(go.dataset.go);
  if (event.target.closest('[data-close]')) return event.target.closest('dialog').close();

  const open = event.target.closest('[data-open-content]');
  if (open) {
    $('#global-search-dialog')?.close();
    return openContent(open.dataset.openContent);
  }

  const cancel = event.target.closest('[data-cancel-job]');
  if (cancel && confirm('Cancel this generation job after its current stage?')) {
    await mutate(`/api/jobs/${encodeURIComponent(cancel.dataset.cancelJob)}/cancel`, 'POST', {}, 'Cancellation requested.').catch(() => {});
  }

  const idea = event.target.closest('[data-generate-idea]');
  if (idea) {
    await mutate(`/api/ideas/${encodeURIComponent(idea.dataset.generateIdea)}/generate`, 'POST', { length: 'medium' }, 'Idea queued for generation.').catch(() => {});
  }

  const resume = event.target.closest('[data-resume-job]');
  if (resume) {
    const jobId = resume.dataset.resumeJob;
    const select = $$('[data-resume-stage-for]').find(item => item.dataset.resumeStageFor === jobId);
    const stage = select?.value;
    if (confirm(`Resume this job from ${label(stage)}? Later checkpoints will be regenerated.`)) {
      await mutate(`/api/jobs/${encodeURIComponent(jobId)}/resume`, 'POST', { stage }, `Generation resumed from ${label(stage)}.`).catch(() => {});
    }
  }

  const learning = event.target.closest('[data-learning-action]');
  if (learning) {
    const action = learning.dataset.learningAction;
    const id = learning.dataset.learningId;
    const message = action === 'approve'
      ? 'Learning approved for future autonomous plans.'
      : 'Learning rejected and excluded from future plans.';
    await mutate(`/api/learning/recommendations/${encodeURIComponent(id)}/${action}`, 'POST', {}, message).catch(() => {});
  }

  const refreshRetention = event.target.closest('#refresh-retention-button');
  if (refreshRetention?.dataset.videoId) {
    refreshRetention.disabled = true;
    try {
      await api(`/api/retention/${encodeURIComponent(refreshRetention.dataset.videoId)}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ measurementWindow: refreshRetention.dataset.measurementWindow || 'rolling' })
      });
      showToast('Retention curve refreshed from YouTube Analytics.');
      await refreshDashboard(true);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      refreshRetention.disabled = false;
    }
  }

  const proposeShorts = event.target.closest('[data-propose-shorts]');
  if (proposeShorts) {
    const productionId = proposeShorts.dataset.proposeShorts;
    const replacing = Boolean(document.querySelector('[data-short-card]'));
    if (replacing && !confirm('Replace the current editable Short drafts? Rendered draft files will remain on disk but their manifest will be replaced.')) return;
    try {
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/propose`, {
        method: 'POST', body: JSON.stringify({ count: 3, replace: replacing })
      });
      await refreshContentDialog(productionId, 'Three local Short drafts created from the current scene timeline.');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const shortAction = event.target.closest('[data-short-save], [data-short-render], [data-short-approve]');
  if (shortAction) {
    const card = shortAction.closest('[data-short-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    const clipId = card?.dataset.shortCard;
    if (!productionId || !clipId) return;
    try {
      const values = shortFormData(card);
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}`, {
        method: 'PATCH', body: JSON.stringify(values)
      });
      if (shortAction.matches('[data-short-save]')) {
        await refreshContentDialog(productionId, 'Short draft saved.');
        return;
      }
      if (shortAction.matches('[data-short-render]')) {
        await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/render`, {
          method: 'POST', body: '{}'
        });
        await refreshContentDialog(productionId, 'Vertical Short rendered locally with mobile captions.');
        return;
      }
      if (!confirm('Confirm the inherited evidence, media rights, privacy, and publish time for this Short?')) return;
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/approve`, {
        method: 'POST', body: JSON.stringify({ ...values, confirmed: true })
      });
      await refreshContentDialog(productionId, 'Short approved and added to the publishing schedule.');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const sceneButton = event.target.closest('[data-scene-save], [data-scene-narration], [data-scene-regenerate], [data-scene-lock], [data-scene-move]');
  if (sceneButton) {
    const card = sceneButton.closest('[data-scene-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    const sceneId = card?.dataset.sceneCard;
    if (!productionId || !sceneId) return;
    try {
      if (sceneButton.matches('[data-scene-lock]')) {
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}`, {
          method: 'PATCH', body: JSON.stringify({ locked: !card.classList.contains('locked') })
        });
        await refreshContentDialog(productionId, card.classList.contains('locked') ? 'Scene unlocked.' : 'Scene locked.');
        return;
      }
      if (sceneButton.matches('[data-scene-move]')) {
        const cards = $$('[data-scene-card]');
        const index = cards.indexOf(card);
        const target = sceneButton.dataset.sceneMove === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= cards.length) return;
        const ids = cards.map(item => item.dataset.sceneCard);
        [ids[index], ids[target]] = [ids[target], ids[index]];
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/reorder`, {
          method: 'POST', body: JSON.stringify({ sceneIds: ids })
        });
        await refreshContentDialog(productionId, 'Timeline order updated. Rebuild before approval.');
        return;
      }
      await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}`, {
        method: 'PATCH', body: JSON.stringify(sceneFormData(card))
      });
      if (sceneButton.matches('[data-scene-save]')) {
        await refreshContentDialog(productionId, 'Scene draft saved.');
        return;
      }
      if (sceneButton.matches('[data-scene-narration]')) {
        if (!confirm('Regenerate narration for only this scene? This may consume TTS provider credits; the provider invoice is authoritative.')) return;
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/narration`, {
          method: 'POST', body: JSON.stringify({ confirmCost: true })
        });
        await refreshContentDialog(productionId, 'Scene narration regenerated. Rebuild the final video when every narration segment is ready.');
        return;
      }
      const estimate = await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/estimate`);
      const message = estimate.paid
        ? `Regenerate only this scene with ${estimate.provider} (${estimate.generatedSeconds}s). This consumes provider credits; the provider invoice is authoritative. Continue?`
        : 'Regenerate only this scene with the configured image provider? A live image request may consume provider credits. Continue?';
      if (!confirm(message)) return;
      await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/regenerate`, {
        method: 'POST', body: JSON.stringify({ confirmPaid: estimate.paid })
      });
      await refreshContentDialog(productionId, 'Scene regenerated. Rebuild the final video when the timeline is ready.');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const silenceAction = event.target.closest('[data-intentional-silence], [data-require-narration]');
  if (silenceAction) {
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (!productionId) return;
    const enabled = silenceAction.matches('[data-intentional-silence]');
    let reason = '';
    if (enabled) {
      reason = prompt('Why is this production intentionally silent? This reason is stored with the approval evidence.') || '';
      if (!reason) return;
      if (!confirm('Confirm that this production is intentionally silent. Captions and visuals will remain, and approval will record this override.')) return;
    } else if (!confirm('Require narration again? Approval will be blocked until missing scene narration is regenerated and the video is rebuilt.')) {
      return;
    }
    try {
      await api(`/api/content/${encodeURIComponent(productionId)}/narration/silence`, {
        method: 'POST', body: JSON.stringify({ enabled, confirmed: enabled, reason })
      });
      await refreshContentDialog(productionId, enabled ? 'Intentional silence recorded. Rebuild before approval.' : 'Narration is required again.');
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const rebuildScenes = event.target.closest('[data-rebuild-scenes]');
  if (rebuildScenes) {
    const productionId = rebuildScenes.dataset.rebuildScenes;
    if (confirm('Rebuild a new final MP4 from the current scene timeline? The previous final video will be preserved.')) {
      try {
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/rebuild`, { method: 'POST', body: '{}' });
        await refreshContentDialog(productionId, 'Final video rebuilt from the repaired timeline. Review it before approval.');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
    return;
  }

  const addSource = event.target.closest('[data-add-provenance-source]');
  if (addSource) {
    const list = $('#provenance-sources');
    list.querySelector('.empty-inline')?.remove();
    list.insertAdjacentHTML('beforeend', renderSourceEditor({ id: clientId('source') }));
    return;
  }

  const addClaim = event.target.closest('[data-add-provenance-claim]');
  if (addClaim) {
    const list = $('#provenance-claims');
    list.querySelector('.empty-inline')?.remove();
    list.insertAdjacentHTML('beforeend', renderClaimEditor({ id: clientId('claim') }, currentSourceOptions()));
    return;
  }

  const removeProvenance = event.target.closest('[data-remove-provenance]');
  if (removeProvenance) {
    removeProvenance.closest('.provenance-item')?.remove();
    return;
  }

  const saveProvenance = event.target.closest('[data-save-provenance]');
  if (saveProvenance) {
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (productionId) await persistProvenance(productionId, 'Evidence review saved.').catch(() => {});
    return;
  }

  const save = event.target.closest('[data-save-content]');
  if (save) {
    try {
      await persistProvenance(save.dataset.saveContent);
      await mutate(`/api/content/${encodeURIComponent(save.dataset.saveContent)}`, 'PATCH', contentFormData(), 'Draft and evidence review saved.');
    } catch (_error) { /* toast already shown */ }
  }

  const approve = event.target.closest('[data-approve-content]');
  if (approve) {
    try {
      await persistProvenance(approve.dataset.approveContent);
      await mutate(`/api/content/${encodeURIComponent(approve.dataset.approveContent)}/approve`, 'POST', contentFormData(), 'Content approved and scheduled.');
      $('#content-dialog').close();
    } catch (_error) { /* toast already shown */ }
  }

  const reject = event.target.closest('[data-reject-content]');
  if (reject) {
    const notes = prompt('Reject and permanently delete this video and generated assets? Enter a reason:', 'Needs a different angle');
    if (notes !== null) {
      await mutate(`/api/content/${encodeURIComponent(reject.dataset.rejectContent)}/reject`, 'POST', { notes }, 'Content rejected and generated video deleted.').catch(() => {});
      $('#content-dialog').close();
    }
  }

  const retry = event.target.closest('[data-retry-content]');
  if (retry && confirm('Generate a fresh version using the same topic?')) {
    await mutate(`/api/content/${encodeURIComponent(retry.dataset.retryContent)}/retry`, 'POST', {}, 'Regeneration started.').catch(() => {});
    $('#content-dialog').close();
  }
});

document.addEventListener('change', event => {
  if (event.target.matches('#retention-snapshot-select')) {
    ui.retentionSnapshotId = event.target.value;
    renderRetention(ui.state?.learning?.retention || {});
  }
  if (event.target.matches('[name="selectedTitleVariant"]')) {
    const title = event.target.selectedOptions[0]?.dataset.title;
    const input = $('#content-review-form [name="title"]');
    if (title && input) input.value = title;
  }
  if (event.target.matches('[data-scene-upload]')) {
    const file = event.target.files?.[0];
    const card = event.target.closest('[data-scene-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (file && card && productionId) {
      uploadSceneAsset(productionId, card.dataset.sceneCard, file);
    }
  }
});

$('#generate-button')?.addEventListener('click', () => $('#generate-dialog').showModal());
$('#overview-create-button').addEventListener('click', () => $('#generate-dialog').showModal());
$('#top-generate-button').addEventListener('click', () => $('#generate-dialog').showModal());
$('#global-search-button').addEventListener('click', () => {
  renderGlobalSearch();
  $('#global-search-dialog').showModal();
  $('#global-search-input').focus();
});
$('#global-search-input').addEventListener('input', event => renderGlobalSearch(event.target.value));
$('#notifications-button').addEventListener('click', () => {
  switchView('overview');
  document.querySelector('#notification-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelectorAll('[data-niche-suggestion]').forEach(button => {
  button.addEventListener('click', () => {
    $('#niche-finder-form [name="niche"]').value = button.dataset.nicheSuggestion;
    $('#niche-finder-form [name="niche"]').focus();
  });
});
$('#niche-finder-form').addEventListener('submit', async event => {
  event.preventDefault();
  const niche = event.currentTarget.elements.niche.value.trim();
  if (!niche) return;
  $('#loading').classList.add('active');
  try {
    const response = await api('/api/niche/research', { method: 'POST', body: JSON.stringify({ niche }) });
    renderNicheFinderResults(response.result || {});
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
});
function updateCreatePreview() {
  const form = $('#generate-form');
  if (!form) return;
  const field = name => form.querySelector(`[name="${name}"]`);
  const topic = field('topic')?.value.trim() || 'Your story';
  const style = field('style')?.selectedOptions[0]?.textContent || 'Explainer';
  const imageStyle = field('imageStyle')?.selectedOptions[0]?.textContent || 'Cinematic';
  const scenes = field('sceneCount')?.value || '8';
  const length = field('length')?.selectedOptions[0]?.textContent || '8–12 min';
  const topicNode = $('[data-preview-topic]');
  const styleNode = $('[data-preview-style]');
  const scenesNode = $('[data-preview-scenes]');
  const lengthNode = $('[data-preview-length]');
  if (topicNode) topicNode.textContent = topic.slice(0, 34).toUpperCase();
  if (styleNode) styleNode.textContent = `${imageStyle} ${style}`.toUpperCase();
  if (scenesNode) scenesNode.textContent = `${scenes} scenes`;
  if (lengthNode) lengthNode.textContent = length.replace(' · ', ' ');
}
document.querySelectorAll('[data-create-style]').forEach(button => {
  button.addEventListener('click', () => {
    const form = $('#generate-form');
    form.querySelector('[name="style"]').value = button.dataset.createStyle;
    document.querySelectorAll('[data-create-style]').forEach(item => item.classList.toggle('selected', item === button));
    updateCreatePreview();
  });
});
$('#generate-form').addEventListener('input', updateCreatePreview);
$('#generate-form').addEventListener('change', updateCreatePreview);
const generationTemplates = {
  mystery: { topic: '', style: 'story', length: 'short', storyType: 'mystery', imageStyle: 'cinematic', character: '', visualStyle: 'moody cinematic narrative', sceneCount: '8', voiceDirection: 'Calm, tense storyteller' },
  scary: { topic: '', style: 'story', length: 'short', storyType: 'scary', imageStyle: 'cinematic', character: '', visualStyle: 'dark atmospheric horror', sceneCount: '8', voiceDirection: 'Low, suspenseful narrator' },
  facts: { topic: '', style: 'explainer', length: 'short', storyType: 'fun_facts', imageStyle: 'photorealistic', character: '', visualStyle: 'clean documentary visuals', sceneCount: '6', voiceDirection: 'Curious, energetic narrator' },
  motivational: { topic: '', style: 'story', length: 'short', storyType: 'motivational', imageStyle: 'cinematic', character: '', visualStyle: 'warm cinematic realism', sceneCount: '8', voiceDirection: 'Warm, encouraging narrator' },
  shorts: { topic: '', style: 'explainer', length: 'short', storyType: 'fun_facts', imageStyle: 'cinematic', character: '', visualStyle: 'bold vertical documentary', sceneCount: '6', voiceDirection: 'Fast, clear narrator' },
  history: { topic: '', style: 'story', length: 'short', storyType: 'history', imageStyle: 'cinematic', character: '', visualStyle: 'period documentary realism', sceneCount: '8', voiceDirection: 'Measured documentary narrator' }
};
const templateCatalog = {
  mystery: { title: 'Mystery story', description: 'A cinematic suspense template with a slow reveal, atmospheric visuals, and a calm storyteller voice.', tags: ['Narrative', 'Cinematic', '8 scenes'] },
  scary: { title: 'Scary story', description: 'A moody short-form horror structure built for tension, shadowy imagery, and a low suspenseful narration style.', tags: ['Dark', 'Suspense', 'Short'] },
  facts: { title: 'Fun facts', description: 'A quick visual explainer format with clean documentary imagery and an energetic narrator.', tags: ['Explainer', 'Fast', 'Visual'] },
  motivational: { title: 'Motivational', description: 'A bold story arc with warm cinematic visuals and an encouraging voice designed for momentum.', tags: ['Story', 'Energetic', 'Bold'] },
  shorts: { title: 'Quick Short', description: 'A vertical-friendly faceless stock structure for fast ideas, clear narration, and compact scenes.', tags: ['Short', 'Vertical', 'Stock'] },
  history: { title: 'Interesting history', description: 'A research-first documentary template with period visuals, measured narration, and room for verified sources.', tags: ['History', 'Research', 'Documentary'] }
};
document.querySelectorAll('[data-template]').forEach(button => {
  button.addEventListener('click', () => {
    const form = $('#generate-form');
    const values = generationTemplates[button.dataset.template];
    if (!form || !values) return;
    for (const [name, value] of Object.entries(values)) {
      const field = form.querySelector(`[name="${name}"]`);
      if (field) field.value = value;
    }
    document.querySelectorAll('[data-create-style]').forEach(item => item.classList.toggle('selected', item.dataset.createStyle === values.style));
    updateCreatePreview();
    $('#generate-dialog').showModal();
  });
});
$('#add-idea-button').addEventListener('click', () => $('#idea-dialog').showModal());
$('#refresh-button')?.addEventListener('click', () => refreshDashboard());
$('#pipeline-filter').addEventListener('change', () => renderPipeline(ui.state?.pipeline || []));

$('#campaign-upload-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#campaign-source-file').files[0];
  if (!file) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Recording provenance…';
  try {
    const campaign = activeCampaign();
    const response = await fetch(`/api/campaigns/${encodeURIComponent(campaign.id)}/source-assets`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-file-name': file.name, 'x-source-folder': campaign.approvedFolder, ...(apiKey() ? { 'x-api-key': apiKey() } : {}) },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    showToast('Approved source footage added with provenance.');
    event.currentTarget.reset();
    await refreshDashboard(true);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Add approved footage';
  }
});

$('#active-campaign-select')?.addEventListener('change', async event => {
  await mutate('/api/campaigns/active', 'PUT', { campaignId: event.currentTarget.value }, 'Active campaign changed.').catch(() => {});
});

$('#campaign-logo-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#campaign-logo-file').files[0];
  if (!file) return;
  try {
    const response = await fetch(`/api/campaigns/${encodeURIComponent(activeCampaign().id)}/logo`, { method: 'PUT', headers: { 'Content-Type': file.type, 'x-file-name': file.name, ...(apiKey() ? { 'x-api-key': apiKey() } : {}) }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Logo upload failed');
    showToast('Official campaign logo saved.');
    event.currentTarget.reset();
    await refreshDashboard(true);
  } catch (error) { showToast(error.message, 'error'); }
});

$('#new-campaign-button')?.addEventListener('click', async () => {
  const name = prompt('Campaign name');
  if (!name?.trim()) return;
  const phrases = prompt('Required phrases, separated by commas (optional)', '') || '';
  await mutate('/api/campaigns', 'POST', {
    name: name.trim(),
    requiredPhrases: phrases.split(',').map(value => value.trim()).filter(Boolean)
  }, 'Campaign created and selected.').catch(() => {});
});

$('#campaign-caption-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const campaign = activeCampaign();
  try {
    const result = await mutate(`/api/campaigns/${encodeURIComponent(campaign.id)}/caption`, 'POST', {
      body: $('#campaign-caption-body').value,
      disclosure: $('#campaign-caption-disclosure').value,
      hashtags: $('#campaign-caption-hashtags').value
    }, 'Compliant caption generated.');
    $('#campaign-caption-preview').textContent = result.result.text;
    $('#campaign-caption-status').textContent = `${result.result.validation.hashtagCount} hashtags · valid`;
    $('#campaign-caption-status').className = 'status success';
  } catch (error) {
    $('#campaign-caption-status').textContent = 'Caption needs fixes';
    $('#campaign-caption-status').className = 'status warning';
  }
});

$('#campaign-asset-list')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-analyze-campaign-asset]');
  if (!button) return;
  button.disabled = true;
  button.textContent = 'Analyzing…';
  try {
    const result = await mutate(`/api/campaigns/${encodeURIComponent(activeCampaign().id)}/source-assets/${encodeURIComponent(button.dataset.analyzeCampaignAsset)}/analyze`, 'POST', {}, 'Highlight analysis completed.');
    const proposals = result.result?.proposals || [];
    const proposalText = proposals.map(proposal => `${proposal.startSeconds}s · ${proposal.duration}s · ${proposal.rationale}`).join('\n') || 'No eligible 10–30 second windows found.';
    showToast(proposalText, proposals.length ? 'success' : 'error');
    if (proposals.length) {
      const card = button.closest('.campaign-asset');
      card.insertAdjacentHTML('beforeend', `<div class="campaign-proposals">${proposals.slice(0, 5).map(proposal => `<button type="button" class="button primary small" data-render-campaign-clip="${escapeHTML(button.dataset.analyzeCampaignAsset)}" data-start="${proposal.startSeconds}" data-duration="${proposal.duration}">Render ${proposal.duration}s clip</button>`).join('')}</div>`);
    }
  } catch (_error) { /* toast already shown */ }
  finally { button.disabled = false; button.textContent = 'Analyze highlights'; }
});

$('#campaign-asset-list')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-render-campaign-clip]');
  if (!button) return;
  const captionText = prompt('Caption text for the clip', 'Highlight moment');
  if (captionText === null) return;
  try {
    const result = await mutate(`/api/campaigns/${encodeURIComponent(activeCampaign().id)}/clips/render`, 'POST', { assetId: button.dataset.renderCampaignClip, startSeconds: Number(button.dataset.start), duration: Number(button.dataset.duration), captionText }, 'Campaign clip rendered.');
    const outputPath = result.result?.outputPath;
    if (outputPath) {
      const compliance = $('#campaign-compliance-panel');
      compliance.dataset.outputPath = outputPath;
      compliance.classList.remove('hidden');
      await reviewCampaignCompliance(outputPath);
    }
  } catch (_error) { /* toast already shown */ }
});

async function reviewCampaignCompliance(outputPath) {
  const status = $('#campaign-compliance-status');
  const checks = $('#campaign-compliance-checks');
  const exportButton = $('#campaign-export-button');
  try {
    const response = await api(`/api/campaigns/${encodeURIComponent(activeCampaign().id)}/compliance`, { method: 'POST', body: JSON.stringify({ outputPath }) });
    const report = response.report;
    checks.innerHTML = report.checks.map(check => `<div class="campaign-compliance-check ${check.passed ? 'passed' : 'failed'}"><span>${check.passed ? '✓' : '×'}</span><strong>${escapeHTML(check.label)}</strong><small>${check.passed ? 'Passed' : 'Failed'}</small></div>`).join('');
    status.textContent = report.passed ? 'All checks passed' : 'Export blocked';
    status.className = `status ${report.passed ? 'success' : 'warning'}`;
    exportButton.dataset.outputPath = outputPath;
    exportButton.classList.toggle('hidden', !report.passed);
  } catch (error) {
    status.textContent = 'Review failed';
    status.className = 'status warning';
    checks.innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
    exportButton.classList.add('hidden');
  }
}

$('#campaign-export-button')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Exporting…';
  try {
    const result = await mutate(`/api/campaigns/${encodeURIComponent(activeCampaign().id)}/exports`, 'POST', { outputPath: button.dataset.outputPath }, 'Compliance passed and export package created.');
    const packageId = result.result?.packageId;
    const files = result.result?.files || {};
    const fileLinks = Object.entries(files).map(([label, filePath]) => {
      const fileName = filePath.split(/[\\/]/).pop();
      return `<a class="campaign-export-file" href="/api/campaigns/${encodeURIComponent(activeCampaign().id)}/exports/${encodeURIComponent(packageId)}/${encodeURIComponent(fileName)}" target="_blank" rel="noopener">${escapeHTML(label.replaceAll('-', ' '))}<span>Download</span></a>`;
    }).join('');
    $('#campaign-export-files').innerHTML = fileLinks;
    $('#campaign-export-files').classList.remove('hidden');
    showToast('Export package ready.');
  } catch (_error) { /* toast already shown */ }
  finally { button.disabled = false; button.textContent = 'Export package'; }
});

$('#run-readiness-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Running live checks…';
  try {
    await mutate('/api/readiness/run', 'POST', {
      includePaidMedia: $('#paid-image-probe').checked,
      includePaidVideo: $('#paid-video-probe').checked
    }, 'Pipeline health check completed.');
    switchView('readiness');
  } catch (_error) { /* toast already shown */ }
  finally {
    button.disabled = false;
    button.textContent = 'Run verified check';
  }
});

$('#automation-toggle').addEventListener('click', async () => {
  const action = ui.state?.system.automationPaused ? 'resume' : 'pause';
  await mutate(`/api/automation/${action}`, 'POST', {}, `Automation ${action}d.`).catch(() => {});
});

function strategyFormData(status = ui.state?.channelStrategy?.status || 'draft') {
  const form = $('#strategy-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    ...values,
    contentPillars: values.contentPillars.split(',').map(value => value.trim()).filter(Boolean),
    cadencePerWeek: Number(values.cadencePerWeek),
    videosPerRun: Number(values.videosPerRun),
    status
  };
}

function renderNicheFinderResults(result) {
  const container = $('#niche-finder-results');
  if (!container) return;
  const opportunities = Array.isArray(result.opportunities) ? result.opportunities : [];
  const signals = Array.isArray(result.signals) ? result.signals : [];
  container.classList.remove('hidden');
  container.innerHTML = `<div class="niche-result-summary"><div><span class="niche-step">2</span><div><h3>Your starting direction</h3><p>${escapeHTML(result.summary || 'Research is ready.')}</p></div></div><button type="button" class="button secondary small" data-use-niche="${escapeHTML(result.niche)}">Use this direction</button></div>
    ${opportunities.length ? `<div class="niche-opportunities"><h3>Video angles worth exploring</h3><div class="niche-opportunity-grid">${opportunities.map((item, index) => `<article><span>${index + 1}</span><strong>${escapeHTML(item)}</strong></article>`).join('')}</div></div>` : ''}
    ${signals.length ? `<div class="niche-signals"><h3>Recent videos in this space</h3>${signals.slice(0, 5).map(signal => `<a class="niche-signal" href="${escapeHTML(signal.url)}" target="_blank" rel="noopener"><span><strong>${escapeHTML(signal.title)}</strong><small>${escapeHTML(signal.channel)} · ${Number(signal.viewCount || 0).toLocaleString()} views</small></span><span aria-hidden="true">↗</span></a>`).join('')}</div>` : '<p class="niche-empty">No live videos were returned. You can still use the suggested angles as an evergreen starting point.</p>'}`;
}

$('#strategy-form').addEventListener('submit', async event => {
  event.preventDefault();
  await mutate('/api/operator/strategy', 'PUT', strategyFormData(), 'Channel strategy saved.').catch(() => {});
});

$('#activate-operator-button').addEventListener('click', async () => {
  if (!$('#strategy-form').reportValidity()) return;
  await mutate('/api/operator/start', 'POST', strategyFormData('active'), 'Video planning started.').catch(() => {});
});

$('#pause-operator-button').addEventListener('click', async () => {
  await mutate('/api/operator/pause', 'POST', {}, 'Video planning paused.').catch(() => {});
});

$('#cancel-operator-run').addEventListener('click', async event => {
  const runId = event.currentTarget.dataset.runId;
  if (runId && confirm('Stop this autonomous run after the current agent stage?')) {
    await mutate(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}, 'Operator stop requested.').catch(() => {});
  }
});

$('#resume-operator-run').addEventListener('click', async event => {
  const runId = event.currentTarget.dataset.runId;
  if (runId && confirm('Resume this operator run from its saved editorial plan and generation checkpoints?')) {
    await mutate(`/api/operator/runs/${encodeURIComponent(runId)}/resume`, 'POST', {}, 'Video planning resumed.').catch(() => {});
  }
});

$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const cartoonContext = values.style === 'cartoon' ? {
    character: values.character,
    visualStyle: values.visualStyle,
    sceneCount: values.sceneCount,
    voiceDirection: values.voiceDirection
  } : {};
  const narrativeContext = {
    storyType: values.storyType,
    imageStyle: values.imageStyle
  };
  try {
    await mutate('/generate', 'POST', { ...values, topic: values.topic.trim() || null, strategyContext: { ...cartoonContext, ...narrativeContext, mode: 'standard' } }, 'Generation job started.');
    $('#generate-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/api/ideas', 'POST', values, 'Idea added to the backlog.');
    $('#idea-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.bannedTopics = values.bannedTopics.split(',').map(value => value.trim()).filter(Boolean);
  try {
    await mutate('/api/profile', 'PUT', values, 'Channel setup saved.');
    await mutate('/api/settings', 'PUT', {
      approval_required: $('#approval-required').checked,
      notification_enabled: $('#notifications-enabled').checked,
      channel_timezone: values.timezone,
      video_provider: values.videoProvider,
      video_engine: values.videoEngine,
      video_generation_mode: values.videoGenerationMode,
      video_clip_duration: Number(values.videoClipDuration),
      video_max_generated_seconds: Number(values.videoMaxGeneratedSeconds)
    }, 'Operator settings saved.');
  } catch (_error) { /* toast already shown */ }
});

$('#api-key-button').addEventListener('click', () => {
  if (requestApiKey() !== null) showToast('Dashboard API key saved in this browser.');
});

const initialView = location.hash.slice(1);
if (['overview', 'operator', 'pipeline', 'campaign', 'calendar', 'analytics', 'readiness', 'settings'].includes(initialView)) switchView(initialView);
refreshDashboard();
setInterval(() => refreshDashboard(true), 8000);

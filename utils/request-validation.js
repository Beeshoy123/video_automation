function validateGenerateRequestBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, status: 400, error: 'Request body must be a JSON object' };
  }

  const value = {
    topic: null,
    style: null,
    length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium',
    strategyContext: null
  };

  if (body.topic !== undefined && body.topic !== null) {
    if (typeof body.topic !== 'string') {
      return { valid: false, status: 400, error: 'topic must be a string' };
    }

    const topic = body.topic.trim();
    if (topic.length > 200) {
      return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
    }
    value.topic = topic || null;
  }

  if (body.style !== undefined && body.style !== null) {
    if (typeof body.style !== 'string') {
      return { valid: false, status: 400, error: 'style must be a string' };
    }

    const allowedStyles = new Set([
      'tutorial',
      'explainer',
      'list',
      'review',
      'story',
      'educational',
      'informative',
      'engaging',
      'professional',
      'ethereal',
      'cartoon'
    ]);
    const style = body.style.trim();

    if (style.length > 50) {
      return { valid: false, status: 400, error: 'style must be 50 characters or less' };
    }

    value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
  }

  if (!['short', 'medium', 'long'].includes(value.length)) {
    return { valid: false, status: 400, error: 'length must be short, medium, or long' };
  }

  if (body.strategyContext !== undefined && body.strategyContext !== null) {
    if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
      return { valid: false, status: 400, error: 'strategyContext must be an object' };
    }
    const limits = {
      angle: 500,
      rationale: 1000,
      audience: 500,
      objective: 1000,
      valueProposition: 1000,
      constraints: 2000,
      character: 300,
      visualStyle: 200,
      sceneCount: 2,
      sceneDuration: 2,
      voiceDirection: 300,
      storyType: 40,
      imageStyle: 40,
      musicTrack: 160,
      musicVolume: 5,
      ttsProvider: 20,
      voiceName: 40,
      voiceRate: 5,
      voiceVolume: 5,
      subtitleStyle: 20,
      aspectRatio: 5,
      subtitlePosition: 10,
      subtitleColor: 7,
      subtitleSize: 2,
      subtitleBackground: 5,
      subtitleOutlineColor: 7,
      subtitleOutlineWidth: 4,
      mediaAssets: 2000,
      fitMode: 10,
      transitionMode: 10
    };
    value.strategyContext = {};
    for (const [key, max] of Object.entries(limits)) {
      if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
      if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
        return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
      }
      value.strategyContext[key] = body.strategyContext[key].trim();
    }
  }

  return { valid: true, value };
}

function validateChannelStrategy(body = {}, current = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Channel strategy must be a JSON object');
  }
  const text = (key, fallback, max) => {
    const value = String(body[key] ?? fallback ?? '').trim();
    if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
    return value;
  };
  const objective = text('objective', current.objective, 1000);
  const audience = text('audience', current.audience, 500);
  if (!objective) throw new Error('A channel objective is required');
  if (!audience) throw new Error('A target audience is required');

  const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
  if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
  const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
  if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
    throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
  }

  const integer = (key, fallback, min, max) => {
    const value = Number(body[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const defaultFormat = text('defaultFormat', current.default_format || 'explainer', 20).toLowerCase();
  const defaultLength = text('defaultLength', current.default_length || 'medium', 20).toLowerCase();
  const status = text('status', current.status || 'draft', 20).toLowerCase();
  if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
    throw new Error('defaultFormat is not supported');
  }
  if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
  if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');

  return {
    objective,
    audience,
    valueProposition: text('valueProposition', current.value_proposition, 1000),
    contentPillars,
    cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || 1, 1, 7),
    videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
    defaultFormat,
    defaultLength,
    successMetric: text('successMetric', current.success_metric, 300),
    constraints: text('constraints', current.constraints, 2000),
    status
  };
}

module.exports = {
  validateGenerateRequestBody,
  validateChannelStrategy
};

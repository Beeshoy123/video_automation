const CONFIG_SCHEMA_VERSION = 2;
const SUPPORTED_CONFIG_VERSIONS = new Set([1, 2]);

const SETTING_KEYS = [
  'approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts',
  'content_buffer_days', 'video_provider', 'video_engine', 'video_generation_mode',
  'video_clip_duration', 'video_max_generated_seconds'
];

function migrateConfig(input = {}) {
  if (!input || typeof input !== 'object' || !SUPPORTED_CONFIG_VERSIONS.has(input.schemaVersion)) {
    throw new Error('Unsupported configuration file');
  }
  const profile = input.profile && typeof input.profile === 'object' ? input.profile : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    product: 'Video Automation Studio',
    exportedAt: input.exportedAt || null,
    profile,
    settings,
    providerProfiles: input.providerProfiles || [{
      id: settings.video_provider || 'slideshow',
      engine: settings.video_engine || 'standard',
      mode: settings.video_generation_mode || 'hybrid'
    }],
    secretsExcluded: true
  };
}

function buildConfig(profile = {}, settings = {}) {
  const portableSettings = Object.fromEntries(SETTING_KEYS
    .filter(key => settings[key] !== undefined)
    .map(key => [key, settings[key]]));
  return migrateConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile,
    settings: portableSettings,
    providerProfiles: [{
      id: portableSettings.video_provider || 'slideshow',
      engine: portableSettings.video_engine || 'standard',
      mode: portableSettings.video_generation_mode || 'hybrid'
    }]
  });
}

module.exports = { CONFIG_SCHEMA_VERSION, SETTING_KEYS, migrateConfig, buildConfig };

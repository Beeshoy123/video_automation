class VoiceProviderRegistry {
  static definitions = [
    { id: 'elevenlabs', label: 'ElevenLabs', modelEnv: 'ELEVENLABS_TTS_MODEL', defaultModel: 'eleven_v3', defaultVoice: null, timeoutMs: 120000, retries: 1, supportsVoiceCatalog: true },
    { id: 'openai', label: 'OpenAI', modelEnv: 'OPENAI_TTS_MODEL', defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'coral', timeoutMs: 120000, retries: 1, supportsVoiceCatalog: true },
    { id: 'gemini', label: 'Gemini', modelEnv: 'GEMINI_TTS_MODEL', defaultModel: 'gemini-3.1-flash-tts-preview', defaultVoice: 'Kore', timeoutMs: 120000, retries: 1, supportsVoiceCatalog: true }
  ];

  constructor(options = {}) {
    this.available = options.available || {};
  }

  list() {
    return VoiceProviderRegistry.definitions.map(definition => ({
      id: definition.id,
      label: definition.label,
      model: process.env[definition.modelEnv] || definition.defaultModel,
      defaultVoice: definition.defaultVoice,
      available: Boolean(this.available[definition.id]),
      timeoutMs: definition.timeoutMs,
      retries: definition.retries,
      supportsVoiceCatalog: definition.supportsVoiceCatalog
    }));
  }

  select(requested = 'auto') {
    const normalized = String(requested || 'auto').toLowerCase();
    if (normalized !== 'auto') {
      return this.list().find(provider => provider.id === normalized && provider.available) || null;
    }
    return this.list().find(provider => provider.available) || null;
  }
}

module.exports = { VoiceProviderRegistry };

const fs = require('fs').promises;
const path = require('path');

class CaptionService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.transcriber = options.transcriber || null;
    this.mode = String(options.mode || process.env.CAPTION_TRANSCRIPTION || 'script').toLowerCase();
  }

  async generate({ audioPath, outputPath, fallback }) {
    if (!outputPath) throw new Error('Caption output path is required');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    if (this.mode === 'openai' && this.transcriber && audioPath) {
      try {
        const transcript = await this.transcriber(audioPath);
        if (transcript?.trim()) {
          await fs.writeFile(outputPath, transcript, 'utf8');
          return { path: outputPath, method: 'speech_aligned', language: 'en' };
        }
      } catch (error) {
        this.logger.warn?.(`Speech transcription failed; using script timing: ${error.message}`);
      }
    }

    const captions = await fallback();
    await fs.writeFile(outputPath, captions, 'utf8');
    return { path: outputPath, method: 'script_timed', language: 'en' };
  }
}

module.exports = { CaptionService };

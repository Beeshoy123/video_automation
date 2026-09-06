const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

class CampaignMediaProvider {
  constructor(id = 'campaign-media-provider') {
    this.id = id;
  }

  describe() {
    return { id: this.id, name: this.id, approvedFootageOnly: true, preservesOriginalAudio: true };
  }

  async probe() { throw new Error('Campaign media provider must implement probe'); }
  async detectSceneChanges() { throw new Error('Campaign media provider must implement detectSceneChanges'); }
  async detectAudioPeak() { throw new Error('Campaign media provider must implement detectAudioPeak'); }
  async render() { throw new Error('Campaign media provider must implement render'); }
}

class LocalFfmpegCampaignProvider extends CampaignMediaProvider {
  constructor(options = {}) {
    super('local-ffmpeg');
    this.execFile = options.execFile || execFileAsync;
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  }

  describe() {
    return { ...super.describe(), name: 'Local FFmpeg campaign renderer', supportsTimedSubtitles: true, supportsLogoOverlay: true, addedMusic: false };
  }

  async probe(filePath) {
    const { stdout } = await this.execFile(this.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', filePath], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video');
    return { duration: Number(parsed.format?.duration || 0), audio: streams.some(stream => stream.codec_type === 'audio'), video: Boolean(video), width: Number(video?.width || 0), height: Number(video?.height || 0), audioPeak: null };
  }

  async detectSceneChanges(filePath) {
    try {
      const { stderr } = await this.execFile(this.ffmpegPath, ['-hide_banner', '-i', filePath, '-filter:v', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024 });
      return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(match => Number(match[1])).filter(Number.isFinite);
    } catch (_error) { return []; }
  }

  async detectAudioPeak(filePath) {
    try {
      const { stderr } = await this.execFile(this.ffmpegPath, ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 2 * 1024 * 1024 });
      const match = stderr.match(/max_volume:\s*(-?[0-9.]+) dB/);
      const maxVolume = match ? Number(match[1]) : null;
      return Number.isFinite(maxVolume) ? { maxVolume, high: maxVolume >= -12 } : null;
    } catch (_error) { return null; }
  }

  async render(args, options = {}) {
    const result = await this.execFile(this.ffmpegPath, args, { maxBuffer: options.maxBuffer || 8 * 1024 * 1024 });
    return { ...result, provider: this.id, addedMusic: false, originalAudioOnly: true };
  }
}

module.exports = { CampaignMediaProvider, LocalFfmpegCampaignProvider };

const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');

const PLATFORM_PROFILES = [
  { id: 'tiktok', layout: 'crop', captionMargin: 300 },
  { id: 'instagram-reels', layout: 'blur', captionMargin: 240 },
  { id: 'youtube-shorts', layout: 'stacked', captionMargin: 190 }
];

function safeTags(tags = []) {
  return [...new Set((Array.isArray(tags) ? tags : []).map(tag => String(tag).trim()).filter(Boolean))];
}

function toHashtags(tags) {
  return tags.map(tag => `#${tag.replace(/^#+/, '').replace(/\s+/g, '')}`).filter(tag => tag.length > 1);
}

function getTitle(bundle) {
  return String(bundle.editorData?.title || bundle.seo?.title || bundle.script?.title || bundle.strategy?.topic || 'Untitled video').trim();
}

function getDescription(bundle) {
  return String(bundle.editorData?.description || bundle.seo?.description || '').trim();
}

function escapeSubtitlePath(filePath) {
  return path.resolve(filePath)
    .replaceAll('\\', '/')
    .replace(':', '\\:')
    .replaceAll("'", "\\'");
}

class PlatformExportService {
  constructor(options = {}) {
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.width = Number(options.width || 1080);
    this.height = Number(options.height || 1920);
  }

  async export(productionId, bundle, outputDir) {
    const sourcePath = bundle.assets?.finalVideo?.path;
    if (!sourcePath || path.extname(sourcePath).toLowerCase() !== '.mp4') {
      throw new Error('A real source MP4 is required before platform export');
    }
    const sourceStats = await fs.stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size <= 0) throw new Error('The source MP4 is empty');

    await fs.mkdir(outputDir, { recursive: true });
    const captionsSource = bundle.assets?.captions?.path;
    let captionsPath = null;
    if (captionsSource) {
      const captionsStats = await fs.stat(captionsSource);
      if (captionsStats.isFile() && captionsStats.size > 0) captionsPath = captionsSource;
    }

    const files = {};
    const platforms = {};
    const title = getTitle(bundle);
    const description = getDescription(bundle);
    const tags = safeTags(bundle.seo?.tags);
    const hashtags = toHashtags(tags);

    for (const profile of PLATFORM_PROFILES) {
      const videoName = `${profile.id}.mp4`;
      const videoPath = path.join(outputDir, videoName);
      const platformCaptionsPath = captionsPath ? path.join(outputDir, `${profile.id}.srt`) : null;
      if (platformCaptionsPath) await fs.copyFile(captionsPath, platformCaptionsPath);
      await this.render(sourcePath, videoPath, profile, platformCaptionsPath);
      files[profile.id] = videoPath;
      if (platformCaptionsPath) files[`${profile.id}Captions`] = platformCaptionsPath;
      platforms[profile.id] = this.platformMetadata(profile, videoName, platformCaptionsPath && path.basename(platformCaptionsPath), title, description, tags, hashtags);
    }

    const metadataPath = path.join(outputDir, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify({
      productionId,
      title,
      description,
      tags,
      aspectRatio: '9:16',
      sourceAspectRatio: bundle.assets.finalVideo.aspectRatio || null,
      platforms,
      createdAt: new Date().toISOString()
    }, null, 2));
    files.metadata = metadataPath;
    return files;
  }

  platformMetadata(profile, video, captions, title, description, tags, hashtags) {
    if (profile.id === 'tiktok') {
      return {
        video,
        captions,
        aspectRatio: '9:16',
        layout: profile.layout,
        caption: [title, description, hashtags.slice(0, 5).join(' ')].filter(Boolean).join('\n\n'),
        hashtags: hashtags.slice(0, 5)
      };
    }
    if (profile.id === 'instagram-reels') {
      return {
        video,
        captions,
        aspectRatio: '9:16',
        layout: profile.layout,
        caption: [description || title, hashtags.join(' ')].filter(Boolean).join('\n\n'),
        hashtags,
        coverFrameSeconds: 0
      };
    }
    return {
      video,
      captions,
      aspectRatio: '9:16',
      layout: profile.layout,
      title: title.toLowerCase().includes('#shorts') ? title : `${title} #Shorts`,
      description,
      tags: [...new Set([...tags, 'Shorts'])]
    };
  }

  async render(sourcePath, outputPath, profile, captionsPath) {
    const captionFilter = captionsPath
      ? `,subtitles='${escapeSubtitlePath(captionsPath)}':force_style='FontName=Arial,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=${profile.captionMargin}'`
      : '';
    const filter = this.videoFilter(profile.layout, captionFilter);
    await this.runFFmpeg([
      '-y', '-i', sourcePath,
      '-filter_complex', filter,
      '-map', '[platformv]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', outputPath
    ]);
    await this.runFFmpeg(['-v', 'error', '-i', outputPath, '-f', 'null', '-']);
    const stats = await fs.stat(outputPath);
    if (!stats.isFile() || stats.size <= 0) throw new Error(`FFmpeg returned an empty ${profile.id} export`);
  }

  videoFilter(layout, captionFilter) {
    const { width, height } = this;
    if (layout === 'crop') {
      return `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}${captionFilter},fps=30,format=yuv420p[platformv]`;
    }
    if (layout === 'stacked') {
      const foregroundHeight = Math.round(height * 0.58);
      const y = Math.round(height * 0.1);
      return `[0:v]split=2[bg][fg];` +
        `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:3[soft];` +
        `[fg]scale=${width}:${foregroundHeight}:force_original_aspect_ratio=decrease[front];` +
        `[soft][front]overlay=(W-w)/2:${y}${captionFilter},fps=30,format=yuv420p[platformv]`;
    }
    return `[0:v]split=2[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:3[soft];` +
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[front];` +
      `[soft][front]overlay=(W-w)/2:(H-h)/2${captionFilter},fps=30,format=yuv420p[platformv]`;
  }
}

module.exports = { PlatformExportService, PLATFORM_PROFILES };
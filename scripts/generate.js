#!/usr/bin/env node
const fs = require('fs').promises;

function usage() {
  console.log(`Video Automation Studio CLI

Usage:
  npm run generate -- --topic "How AI changes work"
  npm run generate -- --topic "First" --topic "Second"
  npm run generate -- --batch-file topics.json --wait

Options:
  --topic <text>             Generate one topic; repeat for a batch
  --batch-file <path>        JSON array, JSONL, or one topic per line
  --style <style>            explainer, tutorial, list, review, story, cartoon
  --length <length>          short, medium, or long
  --format <ratio>           16:9, 9:16, or 1:1
  --scene-duration <sec>     Target generated clip duration, 3-30 seconds
  --fit-mode <mode>          cover or contain
  --transition <mode>        fade or cut
  --music <filename>         Track from data/music
  --music-volume <value>     Background music volume, 0-1
  --voice-provider <name>    auto, openai, gemini, or elevenlabs
  --voice <name>             Provider voice name or ElevenLabs voice ID
  --voice-rate <value>       Narration speed, 0.5-2
  --voice-volume <value>     Narration volume, 0-1.5
  --subtitle-style <style>   clean, bold, neon, or minimal
  --subtitle-position <pos>  top, center, or bottom
  --subtitle-size <value>    Subtitle size, 12-40
  --subtitle-color <color>   Subtitle color, e.g. #FFFFFF
  --subtitle-background      Use a readable subtitle background
  --api-key <key>            Dashboard API key (or YAA_API_KEY environment variable)
  --dry-run                  Validate inputs without queueing generation
  --url <url>                API base URL (default: http://localhost:3456)
  --wait                     Wait for submitted single job to finish
  --help                     Show this help
`);
}

function parseArgs(args) {
  const options = { topics: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2).replaceAll('-', '_');
    if (key === 'wait' || key === 'dry_run' || key === 'subtitle_background') { options[key] = true; continue; }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    index += 1;
    if (key === 'topic') options.topics.push(value);
    else options[key] = value;
  }
  return options;
}

async function readTopics(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed.map(item => typeof item === 'string' ? item : item.topic).filter(Boolean);
  } catch (_error) { /* Treat non-JSON files as line-based input. */ }
  return source.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line).topic || JSON.parse(line); } catch (_error) { return line; }
  });
}

function buildStrategy(options) {
  return {
    mode: 'standard',
    musicTrack: options.music,
    musicVolume: options.music_volume,
    ttsProvider: options.voice_provider || 'auto',
    voiceName: options.voice,
    voiceRate: options.voice_rate,
    voiceVolume: options.voice_volume,
    subtitleStyle: options.subtitle_style || 'clean',
    subtitlePosition: options.subtitle_position,
    subtitleSize: options.subtitle_size,
    subtitleColor: options.subtitle_color,
    subtitleBackground: options.subtitle_background ? 'true' : 'false',
    aspectRatio: options.format || '16:9',
    sceneDuration: options.scene_duration,
    fitMode: options.fit_mode || 'cover',
    transitionMode: options.transition || 'fade'
  };
}

async function request(baseUrl, route, body, apiKeyValue) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKeyValue ? { 'x-api-key': apiKeyValue } : {}) },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function waitForJob(baseUrl, jobId) {
  while (true) {
    const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not read generation job');
    process.stdout.write(`\r${job.title || job.topic || jobId}: ${job.status} ${job.progress || 0}%`);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
      process.stdout.write('\n');
      return job;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (options.batch_file) options.topics.push(...await readTopics(options.batch_file));
  const topics = options.topics.map(topic => String(topic).trim()).filter(Boolean);
  if (!topics.length) throw new Error('Provide --topic or --batch-file');
  if (topics.length > 100) throw new Error('A batch can contain at most 100 topics');
  if (topics.some(topic => topic.length > 200)) throw new Error('Each topic must be 200 characters or less');
  const strategyContext = buildStrategy(options);
  if (options.dry_run) {
    console.log(JSON.stringify({ valid: true, topics: topics.length, strategyContext }, null, 2));
    return;
  }
  const baseUrl = String(options.url || 'http://localhost:3456').replace(/\/$/, '');
  const body = {
    style: options.style,
    length: options.length || 'medium',
    strategyContext
  };
  const apiKeyValue = options.api_key || process.env.YAA_API_KEY || process.env.API_KEY || '';
  const result = topics.length > 1
    ? await request(baseUrl, '/generate/batch', { ...body, topics }, apiKeyValue)
    : await request(baseUrl, '/generate', { ...body, topic: topics[0] }, apiKeyValue);
  console.log(JSON.stringify(result, null, 2));
  if (options.wait && topics.length === 1 && result.result?.id) {
    const job = await waitForJob(baseUrl, result.result.id);
    process.exitCode = job.status === 'completed' ? 0 : 1;
  }
}

main().catch(error => { console.error(`Generation failed: ${error.message}`); process.exitCode = 1; });

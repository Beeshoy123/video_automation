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
  --music <filename>         Track from data/music
  --voice-provider <name>    auto, openai, gemini, or elevenlabs
  --voice <name>             Provider voice name or ElevenLabs voice ID
  --subtitle-style <style>   clean, bold, neon, or minimal
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
    if (key === 'wait') { options.wait = true; continue; }
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
    ttsProvider: options.voice_provider || 'auto',
    voiceName: options.voice,
    subtitleStyle: options.subtitle_style || 'clean',
    aspectRatio: options.format || '16:9'
  };
}

async function request(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  if (topics.length > 20) throw new Error('A batch can contain at most 20 topics');
  const baseUrl = String(options.url || 'http://localhost:3456').replace(/\/$/, '');
  const body = {
    style: options.style,
    length: options.length || 'medium',
    strategyContext: buildStrategy(options)
  };
  const result = topics.length > 1
    ? await request(baseUrl, '/generate/batch', { ...body, topics })
    : await request(baseUrl, '/generate', { ...body, topic: topics[0] });
  console.log(JSON.stringify(result, null, 2));
  if (options.wait && topics.length === 1 && result.result?.id) {
    const job = await waitForJob(baseUrl, result.result.id);
    process.exitCode = job.status === 'completed' ? 0 : 1;
  }
}

main().catch(error => { console.error(`Generation failed: ${error.message}`); process.exitCode = 1; });

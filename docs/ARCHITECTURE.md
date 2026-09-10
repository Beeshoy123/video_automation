# Repository Architecture Guide

This repository is intentionally not a direct clone of the reference Shorts generator. It is a broader production system for end-to-end YouTube channel automation, with stronger review gates, persistence, scheduling, analytics, repair, and publishing flows.

## What this repo is

This project is structured around a durable pipeline:

- research and editorial planning
- script writing
- thumbnail/SEO preparation
- production orchestration
- scene-level repair and review
- publish/schedule
- analytics and learning

That means the architecture is a full app, not just a Shorts renderer.

## Main architectural layers

### 1. App bootstrap

Primary entry point:

- `index.js`

Responsibilities:

- load credentials and database
- initialize agents
- set up Express API routes
- expose dashboard and health endpoints
- manage generation jobs and operator state

### 2. Persisted domain state

Storage and persistence:

- `database/db.js`

Responsibilities:

- SQLite persistence
- production records
- production bundles
- review states
- scheduling
- operator runs
- generation checkpoints and recovery metadata

### 3. Agent layer

Agent files live under `agents/`:

- `content-strategy-agent.js`
- `script-writer-agent.js`
- `thumbnail-designer-agent.js`
- `seo-optimizer-agent.js`
- `production-management-agent.js`
- `publishing-scheduling-agent.js`
- `analytics-optimization-agent.js`

These agents represent distinct phases of the platform workflow, rather than a single batch process.

### 4. Runtime services and shared utilities

Shared logic lives in `utils/`:

- `ai-text-service.js`
- `ai-video-generator.js`
- `voice-providers.js`
- `video-providers.js`
- `faceless-stock-engine.js`
- `shorts-repurposing-service.js`
- `scene-repair-service.js`
- `production-readiness-service.js`
- `generation-recovery-service.js`
- `provenance-service.js`
- `operator-service.js`
- `autonomous-channel-operator.js`

These files contain the reusable parts of the pipeline: provider routing, FFmpeg work, validation, recovery, scene repair, and authoring helpers.

### 5. UI and dashboard

Frontend assets live under `dashboard/`:

- `index.html`
- `app.js`
- `styles.css`

The dashboard is the operator console for pipeline reviews, jobs, settings, and generated assets.

### 6. Input, outputs, and media assets

Runtime data is stored in folders such as:

- `data/`
- `logs/`
- `uploads/`
- `temp/`
- `reports/`

This separation is intentional: persistent operational data and temporary processing data are kept distinct.

## What is already similar to the reference repo

The reference repo focuses on a simple Shorts flow:

- Gemini topic/script planning
- Edge-TTS narration
- Pexels search/download
- FFmpeg scene composition
- avatar injection

This repo already has most of those ideas incorporated, especially in:

- `utils/faceless-stock-engine.js`
- `utils/shorts-repurposing-service.js`
- `utils/ai-video-generator.js`

In other words, the reference repo’s strongest techniques are already present here, but they are embedded inside a broader production system.

## Where the architecture is stronger than the reference repo

The reference repo is a fast generator. This repo is a durable automation platform.

Important advantages already present here:

1. Persistent SQLite records for production state
2. Review and approval gates
3. Scene-level repair and rebuild
4. Scheduling and publishing flows
5. Analytics and learning loops
6. Multi-provider provider routing
7. Recovery and resume support
8. Campaign/source-asset intake and exports

## Why not do a full rewrite

A full rewrite to force this repo to match the reference repo would be a mistake because it would remove the very features that make this project valuable.

The right goal is not “make it look like the reference repo.”
The right goal is:

- keep the stronger production pipeline
- improve the readability of orchestration boundaries
- bring the best Shorts-generation techniques into a cleaner structure

## Improvement plan (exact, prioritized)

### Priority 1 — Split the main app bootstrap

Target file:

- `index.js`

Current issue:

- `index.js` mixes startup, app setup, route registration, validation, scheduling, and operator orchestration in one large file.

Exact changes to make:

1. Create a new module for API registration.
2. Move route setup out of `index.js` into a dedicated module.
3. Keep `index.js` focused on initialization and dependency wiring.
4. Extract validation helpers into a dedicated validation module.

Intended result:

- boot logic becomes easier to read
- route code becomes easier to test
- future changes to endpoints will be less risky

### Priority 2 — Clarify the service boundaries

Target files:

- `utils/faceless-stock-engine.js`
- `utils/shorts-repurposing-service.js`
- `utils/ai-video-generator.js`

Current issue:

- some generation logic and orchestration are interleaved across utilities and agents.

Exact changes to make:

1. Keep pure asset helpers in `utils/`.
2. Keep workflow orchestration in `agents/` or dedicated service classes.
3. Make `faceless-stock-engine` responsible for scene planning and rendering only.
4. Make `shorts-repurposing-service` responsible for window selection and layout-specific rendering only.
5. Keep provider negotiation and file validation in `ai-video-generator`.

Intended result:

- each file has a single clear responsibility
- easier debugging when a pipeline step fails

### Priority 3 — Introduce a small, explicit architecture map

Target files:

- `README.md`
- `docs/ARCHITECTURE.md`

Exact changes to make:

1. Add a repo map showing app bootstrap, agents, utilities, data directories, and dashboard assets.
2. Document which files are orchestration, which are reusable services, and which are data stores.
3. Add a “how to extend this repo safely” section.

Intended result:

- new contributors can understand the system faster
- architecture decisions become easier to maintain

### Priority 4 — Improve the faceless Shorts fast path

Target files:

- `utils/faceless-stock-engine.js`
- `agents/production-management-agent.js`

Current issue:

- the faceless engine already exists, but it is not as clearly separated from the regular production engine.

Exact changes to make:

1. Add a dedicated fast-mode flow for faceless Shorts with a cleaner result contract.
2. Standardize result objects so all production engines return the same metadata shape.
3. Improve query fallback behavior for Pexels search.
4. Add a stronger result ranking pass for the best stock clips.
5. Make transition tuning explicit (fade vs cut vs slide) rather than hidden in one function.

Intended result:

- faster, cleaner Shorts generation
- easier comparison between different engines

### Priority 5 — Split route groups by domain

Target file:

- `index.js`

Exact changes to make:

1. Separate dashboard routes from generation routes.
2. Separate campaign/export routes from standard app routes.
3. Separate operator/admin routes from public routes.
4. Keep `requireAPIKey()` as a shared middleware, but only use it where needed.

Intended result:

- route groups become easier to navigate
- API surface becomes easier to document

## Recommended refactor order

1. Document the current architecture clearly.
2. Move route registration out of `index.js`.
3. Extract validation helpers.
4. Split faceless Shorts orchestration from shared utilities.
5. Add a result contract for engine outputs.
6. Improve the Shorts fast path with better search ranking and transitions.

## Final recommendation

Do not rewrite the repo to match the reference implementation.

Instead, apply a focused structural cleanup that preserves the stronger production architecture and brings in the reference repo’s best Shorts-generation ideas in a more organized, readable way.

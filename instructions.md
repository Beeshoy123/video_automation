# YouTube Automation Agent Startup Instructions

This guide records the setup verified on 2026-08-22 and is intentionally enforced as the default operating instruction for startup, validation, and path-sensitive work in this repository.

## Agent Operating Rules for Startup Environment and Path

- Always operate from the project root: `G:\AI\youtube-automation-agent`.
- Use PowerShell for Windows commands and prefer the repository-root path before running scripts.
- For repo entry commands, use either:

```powershell
cd /d G:\AI\youtube-automation-agent
```

or:

```powershell
Set-Location G:\AI\youtube-automation-agent
```

- Prefer explicit Windows-safe commands, especially:

```powershell
npm.cmd install
npm.cmd start
npm.cmd run walkthrough
```

- If `npm.ps1` is blocked in PowerShell, do not switch to a different shell or a different repo path; use `npm.cmd` or call Node directly:

```powershell
node index.js
```

- If a local Python virtual environment is needed, use the repo-local `.venv` and activate it explicitly:

```powershell
cd /d G:\AI\youtube-automation-agent
.\.venv\Scripts\Activate.ps1
```

- If PowerShell blocks activation, call the interpreter directly instead of inventing a different environment:

```powershell
G:\AI\youtube-automation-agent\.venv\Scripts\python.exe --version
```

- Treat `.env` as required local configuration. Never commit secrets, OAuth tokens, or credentials.
- When starting the app, keep the default local check endpoints in mind:

```text
http://localhost:3456
http://localhost:3456/health
```

- For local-only generation runs, prefer `LOCAL_ONLY_MODE=true` and Gemini-backed text generation unless the user explicitly asks for a different provider path.
- When video generation requires media tooling, verify FFmpeg is on PATH before claiming the pipeline is healthy.
- Do not silently fall back to a different provider or a generic local output if a required configured provider is intentionally selected and unavailable.
- Keep commands path-safe and repo-root-relative. Avoid assuming a different working directory or a different environment after the first startup command.

## Verified Startup Checklist

Use this exact order for a clean startup on this workspace:

1. Install dependencies:

```powershell
cd /d G:\AI\youtube-automation-agent
npm.cmd install
```

2. Configure `.env` before starting the app. At minimum, set a valid `GEMINI_API_KEY` for AI text/TTS support, and optionally set `LOCAL_ONLY_MODE=true` if you want to run without YouTube OAuth.

3. Optionally create and activate the local Python virtual environment if Python tooling is required:

```powershell
cd /d G:\AI\youtube-automation-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

4. Run the guided setup walkthrough:

```powershell
cd /d G:\AI\youtube-automation-agent
npm.cmd run walkthrough
```

5. Start the dashboard:

```powershell
cd /d G:\AI\youtube-automation-agent
npm.cmd start
```

6. Open the dashboard at `http://localhost:3456` and the health endpoint at `http://localhost:3456/health`.

7. Keep the terminal open while using the dashboard and stop it with `Ctrl+C` when done.

## Project Type

This is primarily a Node.js project. The browser interface is served by the Express backend.

- Frontend: `dashboard/index.html`, `dashboard/app.js`, `dashboard/styles.css`
- Backend and API: `index.js`
- Automation agents: `agents/`
- Shared services: `utils/`
- Database: SQLite in `database/`

## Prerequisites

- Windows PowerShell
- Node.js 18 or newer. The verified machine has Node.js 24.18.0.
- npm
- FFmpeg. The walkthrough verified that FFmpeg is available.
- Git, if pushing the project to GitHub
- Python 3.9 or newer only if Python tooling is needed. The verified machine has Python 3.9.13.

## Windows and Setup Notes

- Use `npm.cmd`, not `npm`, when PowerShell reports that `npm.ps1` is blocked.
- Use `python`, not `py`, because the `py` launcher was not installed on the verified machine.
- The walkthrough command is `npm.cmd run walkthrough`, not a misspelled variant.
- The repo uses Node dependencies from `package.json`; Python requirements are not currently part of the project.
- Keep the app root as `G:\AI\youtube-automation-agent` for all startup and diagnostics actions.

## Latest Environment Findings

- Gemini is the expected default provider for local text generation unless the user explicitly asks for another provider path.
- Local-only mode is valid when YouTube OAuth is not configured.
- The project is intentionally a Windows-local startup environment; commands should reflect that path and shell behavior rather than generic Linux-style defaults.

## Install Node Dependencies

PowerShell may block `npm.ps1`. Use `npm.cmd` instead:

```powershell
cd /d G:\AI\youtube-automation-agent
npm.cmd install
```

The dependencies are declared in `package.json` and locked in `package-lock.json`.

The project currently installs Node dependencies, not Python dependencies. There is no `requirements.txt` in this repository, so do not run or invent a Python requirements installation unless that file is added later.

## Optional Python Virtual Environment

A Python virtual environment was created at `.venv`:

```powershell
cd /d G:\AI\youtube-automation-agent
python -m venv .venv
```

PowerShell execution policy may block the activation script. Try:

```powershell
.\.venv\Scripts\Activate.ps1
```

If activation is blocked, use the environment interpreter directly:

```powershell
.\.venv\Scripts\python.exe --version
```

There are currently no Python packages to install because `requirements.txt` is absent.

## Configure Gemini

The local `.env` file is intentionally ignored by Git. Open `.env` and replace the placeholder on this line:

```env
GEMINI_API_KEY=your-actual-gemini-key
```

Get the key from Google AI Studio:

`https://aistudio.google.com/`

Do not commit `.env`, API keys, OAuth secrets, or `config/credentials.json`.

Other providers and settings are documented in `.env.example`.

## Run the Guided Walkthrough

Use the correctly spelled command:

```powershell
npm.cmd run walkthrough
```

The verified setup selected:

- Keep Gemini as the AI provider
- Local slideshow as the video provider, which avoids external video charges
- Skip YouTube OAuth for now
- Channel name: `My Automated Channel`
- Daily posting
- General educational audience
- Upload privacy: `PRIVATE`

The walkthrough saves progress and can be rerun at any time. To enable YouTube uploading later, rerun it and complete the YouTube connection step.

## Start the Dashboard

```powershell
cd /d G:\AI\youtube-automation-agent
npm.cmd start
```

Open:

`http://localhost:3456`

The setup gate depends on the configured providers and run mode. With `LOCAL_ONLY_MODE=true`, local generation can run without YouTube OAuth; uploading and publishing to YouTube still require connecting the channel.

Useful URLs:

- Dashboard: `http://localhost:3456`
- Health check: `http://localhost:3456/health`

Leave the terminal running while using the dashboard. Stop the server with `Ctrl+C`.

## GitHub Setup

The existing remote was originally the upstream repository. To connect this local checkout to the new repository:

```powershell
cd /d G:\AI\youtube-automation-agent
git remote set-url origin https://github.com/Beeshoy123/video_automation.git
git branch -M main
git add -A
git commit -m "Initial project setup"
git push -u origin main
```

Verify the connection:

```powershell
git remote -v
git status
```

If Git is not recognized in PowerShell, install Git for Windows or run the commands in Git Bash.

The repository ignores `.env`, `.venv/`, `node_modules/`, local databases, logs, generated media, and credentials.

## Known Windows and Setup Notes

- Use `npm.cmd`, not `npm`, when PowerShell reports that `npm.ps1` is blocked.
- Use `python`, not `py`, because the `py` launcher was not installed on the verified machine.
- A placeholder Gemini line counts as a configured environment variable. Replace it with a real key before testing Gemini functionality.
- The walkthrough command is `npm run walkthrough`, not `npm run walkthtough`.
- The project uses Node dependencies from `package.json`; Python requirements are not currently part of the project.
- The first `npm install` reported deprecated transitive packages and audit findings. Review with `npm.cmd audit`; do not use `npm audit fix --force` without checking for breaking changes.

## Latest Setup Findings

- A real Gemini API key was detected in `.env` without exposing its value. The key was 54 characters long and was not the placeholder.
- After restarting, the server reported only `youtube` as missing. This confirms that a Gemini API key alone does not unlock the current dashboard.
- A Gemini API key from Google AI Studio and a Google Cloud API key are different credentials. YouTube uploading requires OAuth Client ID and Client Secret plus the browser authorization flow.
- The Google Cloud console may advertise a `$300` free trial. Do not click `Start free` or add a payment card if you do not want billing. Dismiss the banner and stop if Google requires a card for the next step.
- The Google Cloud project created for this setup is `Videoautomation` with project ID `videoautomation-506318`.
- To use the app with Gemini but without YouTube, the code must be changed to support a local-only mode. Until that change is made, the dashboard remains in setup mode without YouTube OAuth.
- Local-only cartoon mode is enabled with `LOCAL_ONLY_MODE=true`. Choose `Original cartoon` in Create video to provide a character, visual style, scene count, and voice direction; the existing Gemini, scene, narration, captions, and FFmpeg pipeline handles the rest.

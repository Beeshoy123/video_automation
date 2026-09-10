# YouTube Automation Agent Startup Instructions

This guide records the setup verified on 2026-08-22.

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

## Verified Startup Checklist

Use this exact order for a clean startup on this workspace:

1. Install dependencies:

```powershell
cd G:\AI\youtube-automation-agent
npm.cmd install
```

2. Configure local environment values in `.env` before starting the app. At minimum, set a valid `GEMINI_API_KEY` for AI text/TTS support, and optionally set `LOCAL_ONLY_MODE=true` if you want to run without YouTube OAuth.

3. Optionally create and activate the local Python virtual environment if Python tooling is required:

```powershell
cd G:\AI\youtube-automation-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script, skip activation and use `./.venv/Scripts/python.exe` directly.

4. Run the guided setup walkthrough:

```powershell
cd G:\AI\youtube-automation-agent
npm.cmd run walkthrough
```

5. Start the dashboard:

```powershell
cd G:\AI\youtube-automation-agent
npm.cmd start
```

If PowerShell still blocks `npm.ps1` or `npm.cmd` is unavailable in a particular shell, start the app directly with:

```powershell
cd G:\AI\youtube-automation-agent
node index.js
```

6. Open the app:

- Dashboard: `http://localhost:3456`
- Health check: `http://localhost:3456/health`

7. Leave the terminal running while using the dashboard. Stop the server with `Ctrl+C`.

## Install Node Dependencies

PowerShell may block `npm.ps1`. Use `npm.cmd` instead:

```powershell
cd C:\Users\HP\youtube-automation-agent
npm.cmd install
```

The dependencies are declared in `package.json` and locked in `package-lock.json`.

The project currently installs Node dependencies, not Python dependencies. There is no `requirements.txt` in this repository, so do not run or invent a Python requirements installation unless that file is added later.

## Optional Python Virtual Environment

A Python virtual environment was created at `.venv`:

```powershell
cd C:\Users\HP\youtube-automation-agent
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
cd C:\Users\HP\youtube-automation-agent
npm.cmd start
```

Open:

`http://localhost:3456`

The dashboard starts in setup mode until valid AI and YouTube credentials are configured. In the current implementation, the `Create video` button stays disabled while `setupRequired` is true, so YouTube OAuth is required even when using the local slideshow provider.

Useful URLs:

- Dashboard: `http://localhost:3456`
- Health check: `http://localhost:3456/health`

Leave the terminal running while using the dashboard. Stop the server with `Ctrl+C`.

## GitHub Setup

The existing remote was originally the upstream repository. To connect this local checkout to the new repository:

```powershell
cd C:\Users\HP\youtube-automation-agent
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

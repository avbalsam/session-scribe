# Agent Guidelines for Session Scribe

## Project Overview

Session Scribe is a Zoom meeting bot that joins meetings, captures audio via WebRTC interception, streams it to a backend for transcription (OpenAI Whisper), and generates clinical session summaries.

### Architecture

- **frontend/** — React + Vite app. Entry form to join meetings, live transcript view, session history.
- **api/** — Python FastAPI backend. Session management, audio WebSocket endpoint, transcription orchestration.
- **bot/** — TypeScript + Puppeteer service. Joins Zoom via web client, captures audio from WebRTC tracks, streams PCM to backend.

### Key Technical Details

- The bot joins Zoom's **web client** (not native app) using Puppeteer
- Audio capture works by **monkey-patching RTCPeerConnection** before page navigation — the injection must happen via `evaluateOnNewDocument` before `page.goto()` or no tracks will be captured
- The bot and backend communicate over internal WebSocket (`ws://`) for audio streaming
- Railway is used for deployment with PR preview environments

## Git & Branching

- Default branch: `main`
- **Never commit directly to `main`.** Always create a feature branch and open a PR.
- Branch naming: `ab/<feature-name>` (e.g. `ab/meeting-link-input`)
- Create feature branches from `main`, open PRs to merge back

## Commit Process

**Important: Always ask before committing.** The user GPG-signs commits, so they need to be present to enter their passphrase when the commit runs.

Workflow:
1. Make your changes
2. Stage relevant files (prefer specific files over `git add -A`)
3. **Ask the user** before committing — show them what's staged and the proposed commit message
4. Wait for approval, then run the commit (the GPG signing prompt will appear for the user)
5. Push and open PRs without asking — no approval needed for those

Commit message style:
- Short imperative subject line (e.g. "Fix audio capture by injecting WebRTC patch before navigation")
- Blank line, then body explaining motivation if non-obvious
- Add `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer

## Pull Requests

- Create PRs via `gh pr create`
- Title: short, descriptive (<70 chars)
- Body: Summary bullets + test plan checklist
- Railway PR environments auto-deploy — check deployment passes before merging

## Testing Changes

- **Frontend**: Check the UI renders correctly, form validation works
- **Bot**: Verify via Railway logs that Zoom join succeeds and audio chunks are captured
- **API**: Endpoints return proper JSON responses

There's no automated test suite currently. Validate manually via the Railway PR environment.

## Common Pitfalls

- **Audio capture timing**: The `AUDIO_CAPTURE_SCRIPT` must be injected via `page.evaluateOnNewDocument()` BEFORE navigating to Zoom. If injected after, RTCPeerConnection is already established and no tracks are intercepted.
- **Zoom link parsing**: Links come in formats like `https://zoom.us/j/123...`, `https://us06web.zoom.us/j/123...`. The regex `/\/j\/(\d+)/` extracts the meeting ID; query params (especially `pwd=`) must be preserved.
- **Environment variables**: The frontend's `VITE_API_URL` must include the full `https://` protocol prefix or fetch calls will resolve as relative paths.
- **ScriptProcessorNode**: Deprecated but used for audio capture because AudioWorklet requires serving a separate file over HTTP. Works fine in Chromium/Puppeteer.

# Agent Guidelines for Session Scribe

## Project Overview

Session Scribe is a Zoom meeting bot that joins meetings, captures audio via WebRTC interception, streams it to a backend for transcription (OpenAI Whisper), and generates clinical session summaries (DIR/Floortime notes).

### Architecture

- **frontend/** — React + Vite app. Login page (email/password + Google OAuth), entry form to join meetings, live transcript view, session history.
- **api/** — Python FastAPI backend. Session management, audio WebSocket endpoint, transcription orchestration, auth proxy to auth service.
- **auth-service/** — Node.js Express + Better Auth. Handles authentication (email/password, Google OAuth), session management, stores users in MySQL.
- **bot/** — TypeScript + Puppeteer service. Joins Zoom via web client, captures audio from WebRTC tracks, streams PCM to backend.

### Auth Flow

1. Frontend sends auth requests to the backend (`VITE_API_URL`), NOT directly to the auth service
2. Backend proxies `/api/auth/*` to the auth service internally (keeps cookies same-origin)
3. Auth service validates sessions via `/internal/validate` endpoint (called by backend's `get_current_user` dependency)
4. Better Auth uses MySQL for persistent user/session storage
5. Cookies use `SameSite=None; Secure` because frontend and backend are on different Railway subdomains

### Key Technical Details

- The bot joins Zoom's **web client** (not native app) using Puppeteer
- Audio capture works by **monkey-patching RTCPeerConnection** before page navigation — the injection must happen via `evaluateOnNewDocument` before `page.goto()` or no tracks will be captured
- The bot and backend communicate over internal WebSocket (`ws://`) for audio streaming
- Railway is used for deployment with PR preview environments

## Deployment (Railway)

### Project Structure

- **Project ID**: `519ecd58-0e41-423f-9709-a3370b977aa8`
- **Production environment**: `22311cfe-93e4-4ad0-a3a1-51b15f07dfad`
- **Services**: session-scribe-frontend, session-scribe-backend, session-scribe-auth, session-scribe-bot, MySQL

### Service Configuration

| Service | Root Dir | Source | Start Command |
|---------|----------|--------|---------------|
| frontend | `/` | avbalsam/session-scribe | (Vite build/preview) |
| backend | `/` | avbalsam/session-scribe | `uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}` |
| auth-service | `auth-service` | avbalsam/session-scribe | `node dist/index.js` |
| bot | `/` | avbalsam/session-scribe | (node) |

### Environment Variables

Use Railway reference syntax for inter-service URLs:
```
# Static values
BETTER_AUTH_SECRET=<random-string>
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>

# Reference variables (use ${{ }} syntax via set_variables, not add_reference_variable)
DATABASE_URL=${{ MySQL.MYSQL_URL }}
AUTH_SERVICE_URL=https://${{ session-scribe-backend.RAILWAY_PUBLIC_DOMAIN }}  # on auth service
AUTH_SERVICE_URL=http://${{ session-scribe-auth.RAILWAY_PRIVATE_DOMAIN }}:3002  # on backend
FRONTEND_URL=https://${{ session-scribe-frontend.RAILWAY_PUBLIC_DOMAIN }}
```

**Important**: When a reference needs a protocol prefix (e.g. `https://`), use `set_variables` with the full string like `"https://${{ service.VAR }}"`. The `add_reference_variable` tool only accepts values starting with `${{`.

### SOP: Making Changes

1. **Branch**: Create `ab/<feature-name>` from `main`
2. **Code**: Make changes, commit (ask user first for GPG signing or use `-c commit.gpgsign=false`)
3. **Push**: Push branch and create PR via `gh pr create`
4. **Verify build**: Check Railway PR environment deploys via `list_deployments` — wait for SUCCESS
5. **Check logs**: Use `get_logs` with `log_type: "deploy"` to verify service starts correctly
6. **Test in browser**: Use Playwright MCP to navigate to the PR frontend URL and test the flow
7. **Debug**: If failing, check build logs, deploy logs, console errors, and network requests
8. **Merge**: Once verified, merge PR (or ask user to merge)
9. **Production**: After merge, verify production deploys succeed. May need to trigger redeploy via a variable change if config was updated after the deploy was queued.

### Common Railway Issues

- **"directory does not exist" build error**: Root directory not set on the service, or code hasn't been pushed/merged to the deploy branch yet
- **CORS errors**: `FRONTEND_URL` not set on the backend service — needed for FastAPI CORS middleware
- **Auth 500 "no such table"**: Database migrations need to run. Auth service runs them on startup via `getMigrations(auth.options)`
- **Cookies not working**: Frontend and backend are different origins on Railway. Cookies need `SameSite=None; Secure`. Auth requests must go through the backend proxy, not directly to the auth service.
- **Reference variables empty**: The referenced service may not have a public domain generated yet. Use `generate_domain` first.
- **Deploy not picking up config changes**: If service config (root dir, start command) was set after a deploy was triggered, the deploy uses the old config. Trigger a new deploy by setting a variable.

## Git & Branching

- Default branch: `main`
- **Never commit directly to `main`.** Branch protection requires PRs.
- Branch naming: `ab/<feature-name>` (e.g. `ab/fix-google-signin-dialog`)
- Create feature branches from `main`, open PRs to merge back

## Commit Process

**Important: Always ask before committing.** The user GPG-signs commits, so they need to be present to enter their passphrase when the commit runs. If GPG fails, use `git -c commit.gpgsign=false commit` as a fallback.

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
- Railway auto-creates PR preview environments — verify the deployment works before merging
- Use Playwright MCP to test the deployed PR environment end-to-end

## Testing Changes

- **Frontend**: Use Playwright MCP to navigate, click buttons, fill forms, check network requests and console errors
- **Auth**: Sign up with email/password in PR environments (Google OAuth won't work in PR envs due to redirect URI restrictions)
- **Bot**: Verify via Railway logs that Zoom join succeeds and audio chunks are captured
- **API**: Endpoints return proper JSON responses

There's no automated test suite currently. Validate manually via the Railway PR environment.

## Common Pitfalls

- **Audio capture timing**: The `AUDIO_CAPTURE_SCRIPT` must be injected via `page.evaluateOnNewDocument()` BEFORE navigating to Zoom. If injected after, RTCPeerConnection is already established and no tracks are intercepted.
- **Zoom link parsing**: Links come in formats like `https://zoom.us/j/123...`, `https://us06web.zoom.us/j/123...`. The regex `/\/j\/(\d+)/` extracts the meeting ID; query params (especially `pwd=`) must be preserved.
- **Environment variables**: The frontend's `VITE_API_URL` must include the full `https://` protocol prefix or fetch calls will resolve as relative paths. Same for any URL variable.
- **ScriptProcessorNode**: Deprecated but used for audio capture because AudioWorklet requires serving a separate file over HTTP. Works fine in Chromium/Puppeteer.
- **Cross-origin auth**: Never try to set cookies directly from the auth service to the frontend — they're different origins. Always proxy through the backend.
- **Better Auth baseURL**: Must point to the backend's public URL (the proxy), not the auth service itself, so OAuth callbacks route correctly.
- **Google OAuth in PR environments**: Won't work — each PR gets a unique domain that's not registered in Google Cloud Console. Use email/password for testing in PR envs.

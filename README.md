# ShortsPilot AI — YouTube Shorts automation starter

A Node.js starter project with a dashboard, Google OAuth connection flow, AI concept generation, AI image + narration generation, MP4 rendering through FFmpeg, upload to YouTube, and a minute-by-minute scheduler.

**Important:** This is a starter implementation, not a hosted service. Real generation and publishing require your own API credentials, Google OAuth setup, and a server that stays online. The default publishing mode is off. Turn it on only after testing uploads privately/unlisted.

## Requirements

- Node.js 20+
- FFmpeg installed and available as `ffmpeg` on your PATH
- An OpenAI API key with access to the selected text, image, and text-to-speech models
- A Google Cloud project with YouTube Data API v3 enabled and OAuth consent configured
- A public HTTPS URL for production; localhost is fine for local development

## Run locally

1. Install Node.js 20+ and FFmpeg.
2. Copy `.env.example` to `.env`.
3. Fill in the environment variables described below.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Open `http://localhost:3000`.

## API keys and external services

### OpenAI

Set `OPENAI_API_KEY`. The server uses:
- `gpt-4.1-mini` through the Responses API to create an original concept/script and metadata
- `gpt-image-1` to generate a visual
- `gpt-4o-mini-tts` to narrate the script

Model availability, API access, image size support, and pricing depend on your account and can change. If a selected model is unavailable, update the model name in `server.js`. Usage is billed separately by the provider.

### Google / YouTube

1. Open Google Cloud Console and create/select a project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. Add yourself as a test user while the app is in testing mode.
4. Create an OAuth client ID of type **Web application**.
5. Add the authorized redirect URI exactly as `http://localhost:3000/auth/google/callback` for local testing.
6. Copy the client ID and client secret into `.env`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback`
7. Restart the server and click **Connect YouTube**.

The app requests YouTube upload and read-only scopes. Google may require verification for production use or additional users. API quota and YouTube account restrictions may limit uploads. YouTube can also restrict API uploads from unverified API projects to private visibility until the project passes the applicable audit. Check the current Google documentation before deploying.

### FFmpeg

FFmpeg turns the generated image and narration into a vertical MP4. Install it from the official FFmpeg website or your operating system package manager and confirm `ffmpeg -version` works in the same environment as Node. This prototype creates a still-image narrated video; it does not yet add animated camera motion or word-synced captions.

## Current workflow

1. Click **Generate a video idea** to create an original script and metadata.
2. Click **Render video** on that item. The server generates a visual and narration, then assembles an MP4.
3. Click **Publish now** or **Schedule**. YouTube uploads are public in this starter, so test with a non-public workflow before using a real channel.
4. Enable **Automatic publishing** only if you want the server's scheduler to publish due, rendered videos. The server must remain online.

The dashboard shows status, errors, scheduled items, and published links. The scheduler checks every minute.

## Production hardening required before public launch

This starter is intentionally small. Do not expose it to the public internet as-is.

- **Secure OAuth/session:** OAuth state is held in process memory, and refresh tokens are saved in a local JSON file. Use a vetted session library, secure HTTP-only cookies, CSRF protections, verified OAuth state/nonce, and encrypted token storage (KMS or equivalent). Do not store tokens in a public or shared file system.
- **Authentication:** Add application login and user authorization before hosting for multiple people.
- **Secrets:** Use a deployment platform's secret manager. Never put API keys in frontend JavaScript or commit `.env`.
- **Queue/retries:** Use a persistent job queue and idempotency to avoid duplicate uploads. Add backoff for transient API failures and token refresh handling.
- **Publishing controls:** Add per-day caps, a global kill switch, content review, private/unlisted test mode, and alerts. Automatic publishing can make content public without a final human check.
- **Quota and policies:** Confirm current YouTube Data API quota, upload limits, channel eligibility, and API project audit requirements. Five daily uploads is not guaranteed.
- **Content quality:** Check factual claims, licensing, and disclosure obligations for synthetic/altered content. Avoid repetitive, mass-produced, or reused content; posting more does not guarantee reach or monetization.
- **Rendering:** Use a proper video pipeline for captions, timing, motion, loudness normalization, safe areas, and retries. Keep output files in durable object storage if deploying to ephemeral hosting.
- **Timezone:** Store timestamps in UTC and make the user's timezone explicit in the UI.

## API endpoints

- `GET /api/state` — dashboard state and integration configuration status
- `POST /api/settings` — daily target, niche, auto-publish toggle
- `GET /auth/google` — begin Google OAuth
- `GET /auth/google/callback` — complete Google OAuth
- `POST /api/videos/generate` — generate concept, script, description, hashtags
- `POST /api/videos/:id/render` — generate image and narration, render MP4
- `POST /api/videos/:id/schedule` — schedule a rendered video
- `POST /api/videos/:id/publish` — upload an MP4 to YouTube
- `GET /api/health` — health check

## Limitations to know

- The daily target is a dashboard goal, not a guarantee from YouTube.
- This project creates a narrated still-image Short, not a fully animated generative video.
- YouTube's API upload and channel policies may affect public publishing.
- The local JSON database is suitable only for a single-user prototype, not production.

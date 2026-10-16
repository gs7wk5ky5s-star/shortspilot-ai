require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cron = require("node-cron");
const OpenAI = require("openai");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const OUTPUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "db.json");
const initialDb = { connected: false, channel: null, videos: [], settings: { dailyTarget: 5, autoPublish: false, niche: "Mixed viral content" } };
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { writeDb(initialDb); return structuredClone(initialDb); }
}
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = readDb();

const oauthConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
function oauthClient() {
  if (!oauthConfigured()) throw new Error("Google OAuth is not configured. Add the Google credentials to .env first.");
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
function openaiClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI is not configured. Add OPENAI_API_KEY to .env first.");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
function publicState() {
  return {
    connected: Boolean(db.connected),
    channel: db.channel,
    settings: db.settings,
    videos: db.videos.map(({ id, title, hook, script, description, hashtags, status, scheduledAt, createdAt, publishedAt, duration, youtubeUrl, error }) => ({ id, title, hook, script, description, hashtags, status, scheduledAt, createdAt, publishedAt, duration, youtubeUrl, error })),
    integrations: {
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      googleConfigured: oauthConfigured(),
      ffmpegAvailable: false
    }
  };
}
function sendError(res, err) {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong." });
}

app.get("/api/state", (_req, res) => res.json(publicState()));

app.post("/api/settings", (req, res) => {
  const target = Math.max(1, Math.min(5, Number(req.body.dailyTarget || 5)));
  db.settings = { ...db.settings, dailyTarget: target, autoPublish: Boolean(req.body.autoPublish), niche: String(req.body.niche || "Mixed viral content").slice(0, 120) };
  writeDb(db);
  res.json(publicState());
});

app.get("/auth/google", (req, res) => {
  try {
    const client = oauthClient();
    const state = crypto.randomBytes(24).toString("hex");
    // For production, store and verify state in a secure, server-side session/cookie.
    // This starter stores a short-lived state value in memory for the callback.
    pendingOAuthState = state;
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly"
      ],
      state
    });
    res.redirect(url);
  } catch (err) { res.status(400).send(err.message); }
});
let pendingOAuthState = null;

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code) throw new Error("Google authorization did not return a code.");
    if (!req.query.state || req.query.state !== pendingOAuthState) throw new Error("OAuth state mismatch. Please reconnect and try again.");
    pendingOAuthState = null;
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);
    const youtube = google.youtube({ version: "v3", auth: client });
    const response = await youtube.channels.list({ part: ["snippet"], mine: true });
    const channel = response.data.items?.[0];
    if (!channel) throw new Error("No YouTube channel was returned for this Google account.");
    // IMPORTANT: For a production deployment, encrypt tokens at rest and use a secure session store.
    db.googleTokens = tokens;
    db.connected = true;
    db.channel = { id: channel.id, title: channel.snippet?.title || "Connected YouTube channel" };
    writeDb(db);
    res.redirect("/?connected=1");
  } catch (err) {
    console.error(err);
    res.status(400).send("YouTube connection failed: " + err.message + " — <a href='/'>Return to dashboard</a>");
  }
});

function youtubeClient() {
  if (!db.googleTokens) throw new Error("Connect your YouTube account first.");
  const auth = oauthClient();
  auth.setCredentials(db.googleTokens);
  auth.on("tokens", (tokens) => {
    db.googleTokens = { ...db.googleTokens, ...tokens };
    writeDb(db);
  });
  return google.youtube({ version: "v3", auth });
}

app.post("/api/videos/generate", async (req, res) => {
  try {
    const client = openaiClient();
    const niche = String(req.body.niche || db.settings.niche || "Mixed viral content");
    const tone = String(req.body.tone || "curious, energetic, accurate");
    const prompt = `Create one original YouTube Short concept in the niche "${niche}". Return JSON only with keys title, hook, script, visualPrompt, description, hashtags. Requirements: strong but truthful opening hook; 35-55 seconds spoken narration; original, advertiser-friendly content; no copied scripts, unverified claims, copyrighted characters, or requests to imitate a living artist. Make it specific and engaging. Tone: ${tone}. Hashtags must be an array of 3-5 strings.`;
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });
    const raw = response.output_text || "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const idea = JSON.parse(cleaned);

    const id = crypto.randomUUID();
    const video = {
      id,
      title: String(idea.title || "Untitled Short").slice(0, 95),
      hook: String(idea.hook || ""),
      script: String(idea.script || ""),
      visualPrompt: String(idea.visualPrompt || ""),
      description: String(idea.description || ""),
      hashtags: Array.isArray(idea.hashtags) ? idea.hashtags.slice(0, 5) : [],
      status: "draft",
      createdAt: new Date().toISOString(),
      scheduledAt: null,
      duration: "35–55 sec",
      youtubeUrl: null,
      error: null
    };
    db.videos.unshift(video);
    writeDb(db);
    res.json({ video: publicState().videos[0], script: video.script, visualPrompt: video.visualPrompt, description: video.description, hashtags: video.hashtags });
  } catch (err) { sendError(res, err); }
});

// Generate narration + a still visual and render a vertical MP4 using ffmpeg.
// ffmpeg must be installed on the server. This endpoint deliberately fails clearly if unavailable.
app.post("/api/videos/:id/render", async (req, res) => {
  try {
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);
    const video = db.videos.find(v => v.id === req.params.id);
    if (!video) throw new Error("Video not found.");
    const client = openaiClient();
    const imagePath = path.join(OUTPUT_DIR, `${video.id}.png`);
    const audioPath = path.join(OUTPUT_DIR, `${video.id}.mp3`);
    const outputPath = path.join(OUTPUT_DIR, `${video.id}.mp4`);

    const imageResult = await client.images.generate({
      model: "gpt-image-1",
      prompt: video.visualPrompt || `A compelling vertical visual for a YouTube Short about ${video.title}. No text, no logos.`,
      size: "1024x1536"
    });
    const imageData = imageResult.data?.[0]?.b64_json;
    if (!imageData) throw new Error("Image generation did not return image data.");
    fs.writeFileSync(imagePath, Buffer.from(imageData, "base64"));

    const speech = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: video.script
    });
    fs.writeFileSync(audioPath, Buffer.from(await speech.arrayBuffer()));

    // A still image with narration. Add motion/captions in a production upgrade.
    await execFileAsync("ffmpeg", [
      "-y", "-loop", "1", "-i", imagePath, "-i", audioPath,
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p",
      "-c:v", "libx264", "-tune", "stillimage", "-c:a", "aac", "-b:a", "192k",
      "-shortest", "-movflags", "+faststart", outputPath
    ]);
    video.status = "ready";
    video.outputPath = outputPath;
    video.error = null;
    writeDb(db);
    res.json({ ok: true, video: publicState().videos.find(v => v.id === video.id) });
  } catch (err) {
    const video = db.videos.find(v => v.id === req.params.id);
    if (video) { video.error = err.message; writeDb(db); }
    sendError(res, err);
  }
});

app.post("/api/videos/:id/schedule", (req, res) => {
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Video not found." });
  const date = new Date(req.body.scheduledAt);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 60_000) return res.status(400).json({ error: "Choose a future time at least one minute from now." });
  video.scheduledAt = date.toISOString();
  video.status = "scheduled";
  writeDb(db);
  res.json({ ok: true, video: publicState().videos.find(v => v.id === video.id) });
});

app.post("/api/videos/:id/publish", async (req, res) => {
  try {
    const video = db.videos.find(v => v.id === req.params.id);
    if (!video) throw new Error("Video not found.");
    if (!video.outputPath || !fs.existsSync(video.outputPath)) throw new Error("Render the video first. The MP4 file is not ready.");
    const youtube = youtubeClient();
    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: video.title.slice(0, 100),
          description: `${video.description || ""}\n\n${(video.hashtags || []).join(" ")}`.trim(),
          categoryId: "22"
        },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
      },
      media: { body: fs.createReadStream(video.outputPath) }
    });
    video.status = "published";
    video.youtubeUrl = `https://www.youtube.com/watch?v=${result.data.id}`;
    video.publishedAt = new Date().toISOString();
    video.error = null;
    writeDb(db);
    res.json({ ok: true, video: publicState().videos.find(v => v.id === video.id) });
  } catch (err) { sendError(res, err); }
});

async function publishDueVideos() {
  if (!db.settings.autoPublish || !db.connected) return;
  const due = db.videos.filter(v => v.status === "scheduled" && v.scheduledAt && new Date(v.scheduledAt) <= new Date());
  for (const video of due) {
    try {
      if (!video.outputPath || !fs.existsSync(video.outputPath)) throw new Error("Scheduled video has no rendered MP4.");
      const youtube = youtubeClient();
      const result = await youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title: video.title.slice(0, 100), description: `${video.description || ""}\n\n${(video.hashtags || []).join(" ")}`.trim(), categoryId: "22" },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(video.outputPath) }
      });
      video.status = "published";
      video.youtubeUrl = `https://www.youtube.com/watch?v=${result.data.id}`;
      video.publishedAt = new Date().toISOString();
      video.error = null;
    } catch (err) {
      video.status = "failed";
      video.error = err.message;
    }
    writeDb(db);
  }
}
cron.schedule("* * * * *", publishDueVideos);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`AI YouTube Studio running at http://localhost:${PORT}`));

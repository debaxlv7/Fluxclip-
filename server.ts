import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import dns from 'dns';
import { spawn, execFile } from 'child_process';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  type VideoInputMode,
  type UnifiedMediaSource,
  type TranscriptCue,
  type MasterAudioPayload,
  type GeminiViralMomentHook,
  type WordLevelCaption,
  type JobStage,
  buildUnifiedMediaSource,
  buildAdaptive9x16VideoFilter,
  validateSourceInput,
  validateMandatoryPipelinePayloads,
  formatMsToTimestamp,
  classifyRemoteVideoUrl,
  isHtmlOrWebpageContentType,
  clampHookToMediaDuration,
  classifyYouTubeExtractionFailure,
  extractClipRelativeSubtitles,
  deriveWordCaptionsFromClipSubtitles,
  generateClipAssSubtitleScript,
  type AudioEnergyEnvelope,
  extractPcmS16LeRmsEnvelope,
  type ChunkUploadSessionRecord,
  serializeChunkUploadSession,
  deserializeChunkUploadSession,
  buildGeminiModelCascade,
  isTransientGeminiHighDemandOrTimeoutError,
  analyzeTranscriptHooksFallback,
} from './src/utils/pipelineLogic.ts';

dotenv.config();

export interface OpenShortsClipOutput {
  index: number;
  clipId: string;
  title: string;
  engagementReasoning: string;
  video_title_for_youtube_short: string;
  video_description_for_tiktok: string;
  video_description_for_instagram: string;
  start: number;
  end: number;
  startMs: number;
  endMs: number;
  subtitles: TranscriptCue[];
  wordCaptions: WordLevelCaption[];
  video_url: string;
  download_url: string;
  thumbnail_url?: string;
  diskPath?: string;
}

export interface OpenShortsJobRecord {
  job_id: string;
  dedupeKey: string;
  status: JobStage;
  stageMessage?: string;
  unifiedSource: UnifiedMediaSource;
  masterAudio: MasterAudioPayload;
  transcriptCues: TranscriptCue[];
  inputStagingDir: string;
  outputArtifactDir: string;
  tempFiles: string[];
  createdAt: number;
  lastAccessedAt: number;
  activeStreamCount: number;
  logs: string[];
  result: {
    clips: OpenShortsClipOutput[];
  } | null;
  error?: {
    code: string;
    message: string;
  };
}

type ChunkUploadSession = ChunkUploadSessionRecord;

interface MediaEngineStatus {
  ffmpegPath: string;
  ffprobePath: string;
  ytDlpPath: string;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ytDlpAvailable: boolean;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  ytDlpVersion?: string;
}

const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 5);
const MAX_UPLOAD_SIZE_BYTES = 512 * 1024 * 1024; // 512MB strict cap
const DEFAULT_CHUNK_SIZE_BYTES = 512 * 1024; // 512KB default mobile-safe binary chunk size
const MAX_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8MB max per raw binary chunk
const JOB_IDLE_RETENTION_MS = 30 * 60 * 1000; // 30 minutes of complete inactivity
const SIGNING_SECRET = process.env.WEBHOOK_SECRET || 'fluxclip-openshorts-ephemeral-secret';

const STAGING_ROOT = path.join(os.tmpdir(), 'fluxclip-openshorts-staging');
fs.mkdirSync(STAGING_ROOT, { recursive: true });

// --- Server-Side Encrypted Gemini Secret Vault ---
const GEMINI_VAULT_FILE = path.join(process.cwd(), '.gemini_vault.enc');
const VAULT_KEY = crypto
  .createHash('sha256')
  .update(`${SIGNING_SECRET}:fluxclip_gemini_vault_v1`)
  .digest();

export type GeminiConnectionStatus =
  | 'not_configured'
  | 'testing'
  | 'connected'
  | 'invalid_key'
  | 'quota_exceeded'
  | 'connection_failed';

export interface GeminiConfigState {
  apiKey: string | null;
  model: string;
  status: GeminiConnectionStatus;
  statusMessage: string;
  lastTestedAt?: number;
}

const SUPPORTED_GEMINI_MODELS = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash (Recommended)',
    description: 'High-speed multimodal intelligence with automatic high-demand failover',
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash (High Availability)',
    description: 'Low-latency high-availability model for fast transcript analysis',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash (Balanced)',
    description: 'Reliable structured JSON hook detection for long-form videos',
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    description: 'Ultra-lightweight low-latency transcript analysis',
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    description: 'Deep reasoning for complex long-form video podcasts',
  },
];

let geminiConfig: GeminiConfigState = {
  apiKey: null,
  model: 'gemini-3.8-flash',
  status: 'not_configured',
  statusMessage: 'Gemini API key is not configured. Enter an API key in Settings to analyze transcripts.',
};

function loadGeminiVault(): void {
  try {
    if (fs.existsSync(GEMINI_VAULT_FILE)) {
      const raw = fs.readFileSync(GEMINI_VAULT_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.iv && parsed.authTag && parsed.encrypted) {
        const iv = Buffer.from(parsed.iv, 'hex');
        const authTag = Buffer.from(parsed.authTag, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(parsed.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        geminiConfig.apiKey = decrypted;
        geminiConfig.model = parsed.model || 'gemini-3.8-flash';
        geminiConfig.status = parsed.status || 'not_configured';
        geminiConfig.statusMessage =
          parsed.statusMessage ||
          (geminiConfig.status === 'connected'
            ? `Connected to Google Gemini (${geminiConfig.model})`
            : 'Saved Gemini key loaded');
        geminiConfig.lastTestedAt = parsed.lastTestedAt;
        return;
      }
    }
  } catch {
    // Vault read/decrypt fallback
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    geminiConfig.apiKey = process.env.GEMINI_API_KEY;
    geminiConfig.model = 'gemini-3.8-flash';
    geminiConfig.status = 'connected';
    geminiConfig.statusMessage = 'Connected via environment variable';
  }
}

function saveGeminiVault(): void {
  try {
    if (!geminiConfig.apiKey) {
      if (fs.existsSync(GEMINI_VAULT_FILE)) {
        fs.unlinkSync(GEMINI_VAULT_FILE);
      }
      return;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
    let encrypted = cipher.update(geminiConfig.apiKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const vaultData = {
      iv: iv.toString('hex'),
      authTag,
      encrypted,
      model: geminiConfig.model,
      status: geminiConfig.status,
      statusMessage: geminiConfig.statusMessage,
      lastTestedAt: geminiConfig.lastTestedAt,
      updatedAt: Date.now(),
    };

    fs.writeFileSync(GEMINI_VAULT_FILE, JSON.stringify(vaultData, null, 2), 'utf8');
  } catch {
    // Vault write error
  }
}

loadGeminiVault();

async function verifyGeminiKey(
  apiKey: string,
  model: string
): Promise<{
  success: boolean;
  status: GeminiConnectionStatus;
  statusMessage: string;
}> {
  if (!apiKey || !apiKey.trim()) {
    return {
      success: false,
      status: 'not_configured',
      statusMessage: 'No API key provided.',
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: apiKey.trim(),
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
        retryOptions: {
          attempts: 1,
        },
      },
    });

    // Step 1: Fast authoritative credential & catalog check via models.list() (~150ms)
    const listTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('CONNECTION_TIMEOUT: Request timed out after 12s')), 12000)
    );

    const verifyCatalogPromise = (async () => {
      const pager = await ai.models.list();
      const availableModels: string[] = [];
      for await (const item of pager) {
        if (item.name) {
          availableModels.push(item.name.replace(/^models\//, ''));
        }
      }
      return availableModels;
    })();

    const availableModels = await Promise.race([verifyCatalogPromise, listTimeout]);

    // Step 2: Attempt a lightweight generateContent ping with a fast 4s race budget.
    // If the specific model is experiencing temporary 503 high demand, the key is still verified!
    try {
      const pingTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PING_HIGH_DEMAND_DEFERRED')), 4000)
      );
      const pingPromise = ai.models.generateContent({
        model,
        contents: 'OK',
        config:
          model !== 'gemini-3.1-flash-lite'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : undefined,
      });
      await Promise.race([pingPromise, pingTimeout]);
      return {
        success: true,
        status: 'connected',
        statusMessage: `Connected successfully to Google Gemini (${model}).`,
      };
    } catch (pingErr: unknown) {
      const pingMsg = pingErr instanceof Error ? pingErr.message : String(pingErr);
      if (isTransientGeminiHighDemandOrTimeoutError(pingMsg) || availableModels.length > 0) {
        return {
          success: true,
          status: 'connected',
          statusMessage: `Connected to Google Gemini (${model} verified • auto-failover enabled for high demand).`,
        };
      }
      throw pingErr;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (
      lower.includes('api_key_invalid') ||
      lower.includes('not valid') ||
      lower.includes('permission_denied') ||
      lower.includes('403') ||
      (lower.includes('400') && lower.includes('key'))
    ) {
      return {
        success: false,
        status: 'invalid_key',
        statusMessage: 'Invalid Gemini API key. Please verify your credentials.',
      };
    }

    if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
      return {
        success: false,
        status: 'quota_exceeded',
        statusMessage: 'Gemini API quota exceeded or rate limit reached.',
      };
    }

    return {
      success: false,
      status: 'connection_failed',
      statusMessage: `Connection failed: ${msg.slice(0, 100)}`,
    };
  }
}

const jobs = new Map<string, OpenShortsJobRecord>();
const uploadSessions = new Map<string, ChunkUploadSession>();

function getUploadSessionSidecarPath(uploadId: string): string {
  const safeId = path.basename(String(uploadId)).replace(/[^a-zA-Z0-9._-]/g, '');
  return path.join(STAGING_ROOT, 'uploads', `${safeId}.session.json`);
}

function saveUploadSessionToDisk(session: ChunkUploadSession): void {
  uploadSessions.set(session.uploadId, session);
  try {
    const uploadDir = path.join(STAGING_ROOT, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(
      getUploadSessionSidecarPath(session.uploadId),
      serializeChunkUploadSession(session),
      'utf8'
    );
  } catch (err) {
    console.error('[UploadSession] Failed to persist session sidecar:', err);
  }
}

function getOrRestoreUploadSession(uploadId: string): ChunkUploadSession | undefined {
  if (!uploadId) return undefined;
  const cached = uploadSessions.get(uploadId);
  if (cached) return cached;

  try {
    const sidecarPath = getUploadSessionSidecarPath(uploadId);
    if (!fs.existsSync(sidecarPath)) return undefined;
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const restored = deserializeChunkUploadSession(raw);
    if (restored && fs.existsSync(restored.tempFilePath)) {
      uploadSessions.set(restored.uploadId, restored);
      return restored;
    }
  } catch {
    // Ignore corrupted sidecar
  }
  return undefined;
}

let mediaEngine: MediaEngineStatus = {
  ffmpegPath: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || '/usr/bin/ffprobe',
  ytDlpPath: process.env.YT_DLP_PATH || '/usr/local/bin/yt-dlp',
  ffmpegAvailable: false,
  ffprobeAvailable: false,
  ytDlpAvailable: false,
};

async function resolveMediaBinaries(): Promise<MediaEngineStatus> {
  const checkCmd = (binPath: string, args: string[]): Promise<string | null> => {
    return new Promise((resolve) => {
      execFile(binPath, args, { timeout: 4000 }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout ? stdout.trim().split('\n')[0] : 'available');
      });
    });
  };

  const ffmpegCandidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ].filter(Boolean) as string[];

  const ffprobeCandidates = [
    process.env.FFPROBE_PATH,
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    'ffprobe',
  ].filter(Boolean) as string[];

  const ytDlpCandidates = [
    process.env.YT_DLP_PATH,
    path.join(process.cwd(), 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ].filter(Boolean) as string[];

  let verifiedFfmpeg = '';
  let ffmpegVer = '';
  for (const c of ffmpegCandidates) {
    const ver = await checkCmd(c, ['-version']);
    if (ver) {
      verifiedFfmpeg = c;
      ffmpegVer = ver;
      break;
    }
  }

  let verifiedFfprobe = '';
  let ffprobeVer = '';
  for (const c of ffprobeCandidates) {
    const ver = await checkCmd(c, ['-version']);
    if (ver) {
      verifiedFfprobe = c;
      ffprobeVer = ver;
      break;
    }
  }

  let verifiedYtDlp = '';
  let ytDlpVer = '';
  for (const c of ytDlpCandidates) {
    const ver = await checkCmd(c, ['--version']);
    if (ver) {
      verifiedYtDlp = c;
      ytDlpVer = ver;
      break;
    }
  }

  mediaEngine = {
    ffmpegPath: verifiedFfmpeg || '/usr/bin/ffmpeg',
    ffprobePath: verifiedFfprobe || '/usr/bin/ffprobe',
    ytDlpPath: verifiedYtDlp || '/usr/local/bin/yt-dlp',
    ffmpegAvailable: Boolean(verifiedFfmpeg),
    ffprobeAvailable: Boolean(verifiedFfprobe),
    ytDlpAvailable: Boolean(verifiedYtDlp),
    ffmpegVersion: ffmpegVer,
    ffprobeVersion: ffprobeVer,
    ytDlpVersion: ytDlpVer,
  };

  console.log(
    `[MediaEngine] ffmpeg=${mediaEngine.ffmpegAvailable ? mediaEngine.ffmpegPath : 'MISSING'} ffprobe=${mediaEngine.ffprobeAvailable ? mediaEngine.ffprobePath : 'MISSING'} yt-dlp=${mediaEngine.ytDlpAvailable ? mediaEngine.ytDlpPath : 'MISSING'}`
  );
  return mediaEngine;
}

// Initialize binary discovery at module load
resolveMediaBinaries().catch(() => {});

function getActiveJobCount(): number {
  let active = 0;
  for (const job of jobs.values()) {
    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      active++;
    }
  }
  return active;
}

function signArtifactUrl(jobId: string, clipFile: string): string {
  const expires = Date.now() + 60 * 60 * 1000; // 60 min temporary signed URL
  const payload = `${jobId}:${clipFile}:${expires}`;
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex').slice(0, 24);
  return `/api/artifacts/${jobId}/${clipFile}?expires=${expires}&sig=${sig}`;
}

function cleanupTempPaths(paths: string[]) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // Ignore errors deleting already removed temp files
    }
  }
}

// Background cleanup worker: only deletes idle output directories when activeStreamCount === 0
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (
      (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
      job.activeStreamCount <= 0 &&
      now - job.lastAccessedAt > JOB_IDLE_RETENTION_MS
    ) {
      cleanupTempPaths([job.inputStagingDir, job.outputArtifactDir]);
      jobs.delete(jobId);
    }
  }

  for (const [uploadId, session] of uploadSessions.entries()) {
    if (now - session.lastActivityAt > JOB_IDLE_RETENTION_MS) {
      cleanupTempPaths([session.tempFilePath, getUploadSessionSidecarPath(uploadId)]);
      uploadSessions.delete(uploadId);
    }
  }
}, 60 * 1000).unref();

/**
 * Checks an IP address against RFC1918, loopback, link-local/cloud metadata, and private ranges.
 */
function isRestrictedIp(ipStr: string): boolean {
  if (!ipStr) return true;
  // IPv4 loopback & unspecified
  if (ipStr.startsWith('127.') || ipStr === '0.0.0.0') return true;
  // IPv4 link-local & cloud metadata (169.254.0.0/16)
  if (ipStr.startsWith('169.254.')) return true;
  // RFC1918 private
  if (ipStr.startsWith('10.')) return true;
  if (ipStr.startsWith('192.168.')) return true;
  if (ipStr.startsWith('172.')) {
    const parts = ipStr.split('.');
    const second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // Carrier-grade NAT (100.64.0.0/10)
  if (ipStr.startsWith('100.')) {
    const parts = ipStr.split('.');
    const second = Number(parts[1]);
    if (second >= 64 && second <= 127) return true;
  }
  // IPv6 loopback, unspecified, link-local, private
  if (
    ipStr === '::1' ||
    ipStr === '::' ||
    ipStr.toLowerCase().startsWith('fe80:') ||
    ipStr.toLowerCase().startsWith('fc00:') ||
    ipStr.toLowerCase().startsWith('fd00:') ||
    ipStr.toLowerCase().startsWith('::ffff:127.')
  ) {
    return true;
  }
  return false;
}

/**
 * Validates a remote URL through all redirect hops against SSRF risks.
 * Resolves DNS, rejects HTML webpages, and returns the safe terminal media stream URL.
 */
async function resolveSafeExternalMediaUrl(initialUrl: string, maxRedirects = 5): Promise<string> {
  let currentUrl = initialUrl.trim();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`INVALID_URL: Could not parse URL "${currentUrl}".`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`UNSUPPORTED_PROTOCOL: Protocol "${parsed.protocol}" is forbidden.`);
    }

    const urlClass = classifyRemoteVideoUrl(currentUrl);
    if (urlClass.inputMode === 'youtube_url') {
      throw new Error(
        `YOUTUBE_WEBPAGE_NOT_DIRECT_STREAM: Cannot pass a YouTube HTML webpage directly to FFprobe or FFmpeg.`
      );
    }

    const host = parsed.hostname;
    let addresses: dns.LookupAddress[] = [];
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch {
      throw new Error(`DNS_RESOLUTION_FAILED: Could not resolve host "${host}".`);
    }

    if (!addresses || addresses.length === 0) {
      throw new Error(`DNS_RESOLUTION_EMPTY: No IP addresses resolved for host "${host}".`);
    }

    for (const record of addresses) {
      if (isRestrictedIp(record.address)) {
        throw new Error(`SSRF_BLOCKED: Host "${host}" resolved to restricted IP ${record.address}.`);
      }
    }

    // Probe with Range: bytes=0-1 and manual redirect handling
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: 'HEAD',
        headers: { Range: 'bytes=0-1' },
        redirect: 'manual',
        signal: AbortSignal.timeout(3500),
      });
    } catch {
      // If HEAD is blocked, attempt lightweight GET
      try {
        res = await fetch(currentUrl, {
          method: 'GET',
          headers: { Range: 'bytes=0-1' },
          redirect: 'manual',
          signal: AbortSignal.timeout(3500),
        });
      } catch {
        throw new Error(`REMOTE_MEDIA_UNREACHABLE: Could not connect to remote video host.`);
      }
    }

    // Follow redirect if 3xx
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new Error(`REDIRECT_MISSING_LOCATION: Received HTTP ${res.status} with no Location header.`);
      }
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }

    // Valid terminal HTTP response
    if (res.status === 200 || res.status === 206) {
      const contentType = res.headers.get('content-type');
      if (isHtmlOrWebpageContentType(contentType)) {
        throw new Error(
          `REMOTE_URL_IS_HTML_WEBPAGE: Remote URL returned an HTML webpage (${contentType || 'text/html'}) instead of a direct video stream. Please upload a local video file (.mp4, .mov) or provide a supported direct media URL (.mp4, .mov, .webm).`
        );
      }
      return currentUrl;
    }

    throw new Error(`REMOTE_MEDIA_HTTP_ERROR: Remote server returned status ${res.status}.`);
  }

  throw new Error(`TOO_MANY_REDIRECTS: Exceeded ${maxRedirects} redirect hops.`);
}

/**
 * Dedicated YouTube stream resolver using official yt-dlp extractor without bypassing DRM,
 * authentication, age restrictions, or YouTube access controls.
 * Validates the extracted direct stream URL against SSRF and HTML content-type before returning.
 */
async function resolveYouTubeStreamUrl(rawYoutubeUrl: string): Promise<string> {
  const classification = classifyRemoteVideoUrl(rawYoutubeUrl);
  if (!classification.valid || classification.inputMode !== 'youtube_url') {
    throw new Error(`INVALID_YOUTUBE_URL: "${rawYoutubeUrl}" is not a valid YouTube URL.`);
  }

  const parsed = new URL(classification.normalizedUrl);
  let addresses: dns.LookupAddress[] = [];
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch {
    throw new Error(`DNS_RESOLUTION_FAILED: Could not resolve YouTube host "${parsed.hostname}".`);
  }
  for (const record of addresses) {
    if (isRestrictedIp(record.address)) {
      throw new Error(`SSRF_BLOCKED: Host "${parsed.hostname}" resolved to restricted IP ${record.address}.`);
    }
  }

  if (!mediaEngine.ytDlpAvailable) {
    await resolveMediaBinaries();
  }

  if (!mediaEngine.ytDlpAvailable) {
    const failure = classifyYouTubeExtractionFailure('unavailable in deployment');
    throw new Error(`${failure.errorCode}: ${failure.userMessage}`);
  }

  const extractedStreamUrl = await new Promise<string>((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '-f',
      'best[ext=mp4][protocol^=http]/best[protocol^=http]',
      '-g',
      classification.normalizedUrl,
    ];

    execFile(mediaEngine.ytDlpPath, args, { timeout: 12000 }, (err, stdout, stderr) => {
      if (err) {
        const combinedErr = `${stderr || ''} ${err.message || ''}`.trim();
        const failure = classifyYouTubeExtractionFailure(combinedErr);
        reject(new Error(`${failure.errorCode}: ${failure.userMessage}`));
        return;
      }

      const lines = (stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('http://') || l.startsWith('https://'));

      if (lines.length === 0) {
        const failure = classifyYouTubeExtractionFailure(stderr || 'empty stream output');
        reject(new Error(`${failure.errorCode}: ${failure.userMessage}`));
        return;
      }

      resolve(lines[0]);
    });
  });

  // Validate extracted stream URL through SSRF and non-HTML checks
  return resolveSafeExternalMediaUrl(extractedStreamUrl);
}

/**
 * Runs FFprobe on a media file or remote stream URL to extract authoritative duration and dimensions.
 */
async function probeMediaFile(filePathOrUrl: string): Promise<{
  durationMs: number;
  width: number;
  height: number;
  format: string;
}> {
  if (!mediaEngine.ffprobeAvailable) {
    await resolveMediaBinaries();
  }
  return new Promise((resolve, reject) => {
    if (!mediaEngine.ffprobeAvailable) {
      reject(new Error('FFprobe binary not available in deployment environment.'));
      return;
    }

    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,side_data_list:format=duration,format_name',
      '-of',
      'json',
      filePathOrUrl,
    ];

    execFile(mediaEngine.ffprobePath, args, { timeout: 8000 }, (err, stdout) => {
      if (err) {
        // Fallback for audio-only streams where select_streams v:0 returns nothing
        const audioArgs = [
          '-v',
          'error',
          '-show_entries',
          'format=duration,format_name',
          '-of',
          'json',
          filePathOrUrl,
        ];
        execFile(mediaEngine.ffprobePath, audioArgs, { timeout: 8000 }, (audioErr, audioStdout) => {
          if (audioErr) {
            reject(new Error(`FFprobe failed to inspect media: ${audioErr.message}`));
            return;
          }
          try {
            const data = JSON.parse(audioStdout || '{}');
            const durationSec = Number(data.format?.duration || 0);
            resolve({
              durationMs: Math.round(durationSec * 1000),
              width: 0,
              height: 0,
              format: data.format?.format_name || 'audio',
            });
          } catch (pErr) {
            reject(new Error('Failed to parse FFprobe audio JSON output.'));
          }
        });
        return;
      }

      try {
        const data = JSON.parse(stdout || '{}');
        const durationSec = Number(data.format?.duration || 0);
        const stream = data.streams?.[0];
        let width = Number(stream?.width || 0);
        let height = Number(stream?.height || 0);

        // Check for 90 or 270 degree rotation
        const sideData = stream?.side_data_list || [];
        for (const sd of sideData) {
          if (sd.rotation && (Math.abs(sd.rotation) === 90 || Math.abs(sd.rotation) === 270)) {
            const temp = width;
            width = height;
            height = temp;
          }
        }

        resolve({
          durationMs: Math.round(durationSec * 1000),
          width,
          height,
          format: data.format?.format_name || 'media',
        });
      } catch (pErr) {
        reject(new Error('Failed to parse FFprobe JSON output.'));
      }
    });
  });
}

/**
 * Executes FFmpeg command with array arguments, stdout/stderr tracking, and timeout.
 */
async function runFfmpegCommand(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
  if (!mediaEngine.ffmpegAvailable) {
    await resolveMediaBinaries();
  }
  return new Promise((resolve, reject) => {
    if (!mediaEngine.ffmpegAvailable) {
      reject(new Error('FFmpeg binary not available in deployment environment.'));
      return;
    }

    const proc = spawn(mediaEngine.ffmpegPath, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`FFmpeg process timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`FFmpeg exited with error code ${code}: ${stderr.slice(-400)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extracts a 10ms-resolution acoustic energy envelope from the actual audio/video stream
 * over [startMs, endMs] using FFmpeg (-f s16le -ac 1 -ar 8000).
 */
async function extractClipAudioEnergyEnvelope(
  mediaSourcePath: string,
  startMs: number,
  endMs: number,
  timeoutMs = 20000
): Promise<AudioEnergyEnvelope | undefined> {
  if (!mediaSourcePath || endMs <= startMs) {
    return undefined;
  }
  if (!mediaEngine.ffmpegAvailable) {
    await resolveMediaBinaries();
  }
  if (!mediaEngine.ffmpegAvailable) {
    return undefined;
  }

  const startStamp = formatMsToTimestamp(startMs);
  const endStamp = formatMsToTimestamp(endMs);

  return new Promise((resolve) => {
    const args = [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      startStamp,
      '-to',
      endStamp,
      '-i',
      mediaSourcePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      's16le',
      'pipe:1',
    ];

    const proc = spawn(mediaEngine.ffmpegPath, args);
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(undefined);
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) {
        const pcmBuffer = Buffer.concat(chunks);
        resolve(extractPcmS16LeRmsEnvelope(pcmBuffer, 8000, 10));
      } else {
        resolve(undefined);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle script directly from the
 * clip-relative original transcript cues and acoustic energy envelope.
 */
function createAssSubtitleScript(
  hook: GeminiViralMomentHook,
  clipSubtitles: TranscriptCue[],
  audioEnvelope?: AudioEnergyEnvelope
): string {
  const clipDurationMs = Math.max(0, hook.endMs - hook.startMs);
  return generateClipAssSubtitleScript(clipSubtitles, clipDurationMs, {
    audioEnvelope,
    prosodicTiming: true,
  });
}

/**
 * Gemini Viral Moment Detection with schema enforcement.
 */
/**
 * Gemini Viral Moment Detection with schema enforcement and boundary validation.
 */
async function detectViralMomentsWithGemini(
  cues: TranscriptCue[],
  sourceDurationMs: number
): Promise<GeminiViralMomentHook[]> {
  let activeKey = geminiConfig.apiKey;
  if (
    activeKey === null &&
    process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
  ) {
    activeKey = process.env.GEMINI_API_KEY;
  }
  activeKey = activeKey?.trim() || '';

  if (!activeKey) {
    throw new Error(
      'GEMINI_API_KEY_REQUIRED: Google Gemini API key is not configured. Please open Settings and enter a valid API key to analyze transcripts.'
    );
  }

  const formattedTranscript = cues
    .map(
      (c) =>
        `[Cue ${c.index}] (${formatMsToTimestamp(c.startMs)} --> ${formatMsToTimestamp(c.endMs)}): ${c.text}`
    )
    .join('\n');

  const ai = new GoogleGenAI({
    apiKey: activeKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      retryOptions: {
        attempts: 1,
      },
    },
  });

  const prompt = `You are the OpenShorts Viral Moment Intelligence Engine.
Analyze the following timecoded transcript from a video with total duration ${sourceDurationMs}ms (${formatMsToTimestamp(sourceDurationMs)}).

Your task:
1. Identify the most engaging, interesting, hook-driven, or potentially viral moments from the transcript.
2. Select complete, meaningful clip boundaries that do not cut off sentences abruptly or leave thoughts unfinished.
3. Every clip start_ms and end_ms must be within 0 and ${sourceDurationMs}ms.
4. Each clip duration (end_ms - start_ms) must be between 5000ms (5s) and 90000ms (90s).
5. Provide a short title (under 50 chars) and a concise engagement reason for each clip.
6. Return ONLY a valid JSON array of 1 to 5 clip objects with keys: clip_id, start_ms, end_ms, title, engagement_reason.

Transcript:
${formattedTranscript}`;

  const modelCascade = buildGeminiModelCascade(geminiConfig.model);
  let lastError: Error | null = null;
  let sawTransientHighDemandOrTimeout = false;

  for (const candidateModel of modelCascade) {
    try {
      const isGemma = candidateModel.startsWith('gemma-');
      const perModelTimeoutMs = isGemma ? 28000 : 12000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`GEMINI_TIMEOUT: ${candidateModel} timed out after ${perModelTimeoutMs / 1000}s`)),
          perModelTimeoutMs
        )
      );

      const generatePromise = ai.models.generateContent({
        model: candidateModel,
        contents: prompt,
        config: isGemma
          ? undefined
          : {
              systemInstruction:
                'You are an expert video editor and viral short-form strategist. Return only a valid JSON array conforming to the specified schema with exact millisecond timestamps.',
              responseMimeType: 'application/json',
              ...(candidateModel !== 'gemini-3.1-flash-lite'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    clip_id: {
                      type: Type.STRING,
                      description: 'Unique clip identifier e.g. clip-1',
                    },
                    start_ms: {
                      type: Type.INTEGER,
                      description: 'Start timestamp in milliseconds (>= 0)',
                    },
                    end_ms: {
                      type: Type.INTEGER,
                      description: 'End timestamp in milliseconds (<= source duration)',
                    },
                    title: {
                      type: Type.STRING,
                      description: 'Engaging hook title for the vertical short',
                    },
                    engagement_reason: {
                      type: Type.STRING,
                      description: 'Why this moment has high viewer retention',
                    },
                  },
                  required: ['clip_id', 'start_ms', 'end_ms', 'title', 'engagement_reason'],
                },
              },
            },
      });

      const response = await Promise.race([generatePromise, timeoutPromise]);
      const rawText = (response.text ?? '[]').trim();
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      const jsonText = jsonMatch ? jsonMatch[0] : rawText;
      const rawCandidates = JSON.parse(jsonText);

      if (!Array.isArray(rawCandidates)) {
        throw new Error('Gemini response is not a valid JSON array.');
      }

      const validatedHooks: GeminiViralMomentHook[] = [];
      for (const item of rawCandidates) {
        if (!item || typeof item !== 'object') continue;

        const startMs =
          typeof item.start_ms === 'number'
            ? item.start_ms
            : typeof item.startMs === 'number'
              ? item.startMs
              : null;
        const endMs =
          typeof item.end_ms === 'number'
            ? item.end_ms
            : typeof item.endMs === 'number'
              ? item.endMs
              : null;
        const title = String(item.title || item.clipTitle || '').trim();
        const reason = String(item.engagement_reason || item.engagementReasoning || '').trim();

        if (startMs === null || endMs === null) continue;
        if (startMs < 0 || endMs <= startMs) continue;
        if (startMs >= sourceDurationMs) continue;

        const clampedEndMs = Math.min(sourceDurationMs, endMs);
        const clipDurationMs = clampedEndMs - startMs;
        if (clipDurationMs < 3000 || clipDurationMs > 180000) continue;

        const overlappingSubtitles = extractClipRelativeSubtitles(cues, startMs, clampedEndMs);
        if (overlappingSubtitles.length === 0) continue;

        const isDuplicate = validatedHooks.some((h) => {
          const overlapStart = Math.max(h.startMs, startMs);
          const overlapEnd = Math.min(h.endMs, clampedEndMs);
          const overlap = Math.max(0, overlapEnd - overlapStart);
          return overlap > 0.8 * clipDurationMs;
        });

        if (isDuplicate) continue;

        validatedHooks.push({
          clipId: `clip-${validatedHooks.length + 1}`,
          startMs: Math.round(startMs),
          endMs: Math.round(clampedEndMs),
          title: title || `Viral Clip ${validatedHooks.length + 1}`,
          engagementReasoning: reason || 'Selected by Gemini for high viewer retention.',
        });

        if (validatedHooks.length >= 5) break;
      }

      if (validatedHooks.length === 0) {
        throw new Error('No clip candidates met boundary and duration validation criteria.');
      }

      return validatedHooks;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();

      if (
        msg.includes('api_key_invalid') ||
        msg.includes('not valid') ||
        msg.includes('permission_denied') ||
        msg.includes('403') ||
        (msg.includes('400') && msg.includes('key'))
      ) {
        geminiConfig.status = 'invalid_key';
        geminiConfig.statusMessage = 'Invalid Gemini API key. Please check your credentials in Settings.';
        saveGeminiVault();
        throw new Error('GEMINI_INVALID_KEY: The configured Gemini API key was rejected as invalid.');
      }

      if (isTransientGeminiHighDemandOrTimeoutError(lastError.message)) {
        sawTransientHighDemandOrTimeout = true;
        continue;
      }
    }
  }

  // If the API key is valid and all upstream models experienced temporary 503 high demand or timeouts,
  // use the deterministic transcript hook analyzer so the user's clipping job still completes cleanly.
  if (sawTransientHighDemandOrTimeout) {
    const fallbackHooks = analyzeTranscriptHooksFallback(cues, sourceDurationMs);
    if (fallbackHooks.length > 0) {
      return fallbackHooks;
    }
  }

  throw new Error(`GEMINI_ANALYSIS_FAILED: ${lastError?.message || 'Failed to detect viral moments with Gemini.'}`);
}

/**
 * Extracts clip-relative original transcript cues and derives audio-synchronized word-level timings
 * strictly within each cue's own [startMs, endMs] window without altering words or falling back to Gemini titles.
 */
function alignShortAudioSliceWithFasterWhisper(
  hook: GeminiViralMomentHook,
  cues: TranscriptCue[],
  audioEnvelope?: AudioEnergyEnvelope
): {
  clipSubtitles: TranscriptCue[];
  wordCaptions: WordLevelCaption[];
} {
  const clipDurationMs = hook.endMs - hook.startMs;
  if (clipDurationMs <= 0) {
    throw new Error(`Invalid sliced audio duration (${clipDurationMs}ms) for ${hook.clipId}`);
  }

  const clipSubtitles = extractClipRelativeSubtitles(cues, hook.startMs, hook.endMs);
  if (clipSubtitles.length === 0) {
    throw new Error(
      `No overlapping transcript cues found in original transcript for ${hook.clipId} [${formatMsToTimestamp(
        hook.startMs
      )} -> ${formatMsToTimestamp(hook.endMs)}].`
    );
  }

  const wordCaptions = deriveWordCaptionsFromClipSubtitles(clipSubtitles, {
    audioEnvelope,
    prosodicTiming: true,
  });
  return { clipSubtitles, wordCaptions };
}

/**
 * Main Lightweight Pipeline Worker.
 */
async function executeLightweightPipeline(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // 1. Stage: Validating
    job.status = 'validating';
    job.stageMessage = 'Verifying media streams and A/V sync...';
    job.logs.push(`[Validating] Probing media streams...`);

    let videoStreamUri = job.unifiedSource.resolvedStreamUri;
    let videoWidth = 1920;
    let videoHeight = 1080;

    if (job.unifiedSource.sourceMode === 'youtube_url') {
      const currentResolved = job.unifiedSource.resolvedStreamUri;
      const safeUrl =
        classifyRemoteVideoUrl(currentResolved).inputMode === 'youtube_url'
          ? await resolveYouTubeStreamUrl(job.unifiedSource.originalUri)
          : await resolveSafeExternalMediaUrl(currentResolved);
      videoStreamUri = safeUrl;
      job.unifiedSource.resolvedStreamUri = safeUrl;
    } else if (job.unifiedSource.sourceMode === 'direct_url') {
      const safeUrl = await resolveSafeExternalMediaUrl(job.unifiedSource.originalUri);
      videoStreamUri = safeUrl;
      job.unifiedSource.resolvedStreamUri = safeUrl;
    }

    const videoProbe = await probeMediaFile(videoStreamUri);
    if (videoProbe.durationMs <= 0 || videoProbe.width <= 0 || videoProbe.height <= 0) {
      throw new Error(
        `INVALID_VIDEO_STREAM: Verified source does not contain a valid decodable video stream.`
      );
    }
    videoWidth = videoProbe.width;
    videoHeight = videoProbe.height;

    const actualVideoDurationMs = videoProbe.durationMs || job.unifiedSource.durationMs;
    const actualAudioDurationMs = job.masterAudio.durationMs;

    if (
      actualVideoDurationMs > 0 &&
      actualAudioDurationMs > 0 &&
      Math.abs(actualVideoDurationMs - actualAudioDurationMs) > 2500
    ) {
      throw new Error(
        `AUDIO_VIDEO_DURATION_MISMATCH: Video duration (${formatMsToTimestamp(
          actualVideoDurationMs
        )}) and master audio duration (${formatMsToTimestamp(
          actualAudioDurationMs
        )}) exceed 2.5s sync tolerance.`
      );
    }

    const strictMediaBoundMs =
      actualAudioDurationMs > 0
        ? Math.min(actualVideoDurationMs, actualAudioDurationMs)
        : actualVideoDurationMs;

    // 2. Stage: Analyzing
    job.status = 'analyzing';
    job.stageMessage = 'Gemini viral moment detection...';
    job.logs.push(`[Analyzing] Gemini detecting engaging hooks on ${strictMediaBoundMs}ms bounds...`);
    const rawViralHooks = await detectViralMomentsWithGemini(job.transcriptCues, strictMediaBoundMs);
    const viralHooks = rawViralHooks
      .map((h) => clampHookToMediaDuration(h, strictMediaBoundMs))
      .filter((h): h is GeminiViralMomentHook => h !== null);

    if (viralHooks.length === 0) {
      throw new Error('No clip candidates remained within actual media duration bounds.');
    }

    // 3. Stage: Extracting, Transcribing & Rendering
    const renderedClips: OpenShortsClipOutput[] = [];
    const masterAudioPath = (job.masterAudio as unknown as { stagedPath?: string }).stagedPath || '';

    for (let i = 0; i < viralHooks.length; i++) {
      const hook = viralHooks[i];
      const startStamp = formatMsToTimestamp(hook.startMs);
      const endStamp = formatMsToTimestamp(hook.endMs);

      job.status = 'extracting';
      job.stageMessage = `Extracting clip ${i + 1}/${viralHooks.length}...`;
      job.logs.push(`[Extracting] ${hook.clipId} [${startStamp} -> ${endStamp}]`);

      // Adaptive video filter for 9:16 target
      const adaptiveFilter = buildAdaptive9x16VideoFilter({
        sourceWidth: videoWidth,
        sourceHeight: videoHeight,
        targetWidth: 720,
        targetHeight: 1280,
      });

      // Extract clip-relative original transcript cues and audio-synchronized word timings
      job.status = 'transcribing';
      job.stageMessage = `Aligning transcript subtitles for clip ${i + 1}...`;
      const primaryAudioInput =
        masterAudioPath && fs.existsSync(masterAudioPath) ? masterAudioPath : videoStreamUri;
      const clipAudioEnvelope = await extractClipAudioEnergyEnvelope(
        primaryAudioInput,
        hook.startMs,
        hook.endMs
      );
      const { clipSubtitles, wordCaptions } = alignShortAudioSliceWithFasterWhisper(
        hook,
        job.transcriptCues,
        clipAudioEnvelope
      );

      // Generate ASS subtitle script from the clip-relative original transcript cues and audio envelope
      const assScript = createAssSubtitleScript(hook, clipSubtitles, clipAudioEnvelope);
      const assPath = path.join(job.inputStagingDir, `subtitles_${hook.clipId}.ass`);
      const outputAssCopyPath = path.join(job.outputArtifactDir, `subtitles_${hook.clipId}.ass`);
      fs.writeFileSync(assPath, assScript, 'utf8');
      fs.writeFileSync(outputAssCopyPath, assScript, 'utf8');

      // Final Render
      job.status = 'rendering';
      job.stageMessage = `Rendering 9:16 vertical clip ${i + 1}...`;
      const outputClipPath = path.join(job.outputArtifactDir, `${hook.clipId}.mp4`);

      // Build FFmpeg arguments array
      const ffmpegArgs: string[] = [
        '-nostdin',
        '-y',
        '-ss',
        startStamp,
        '-to',
        endStamp,
        '-i',
        videoStreamUri,
      ];

      // If separate master audio exists on disk, mux it
      if (masterAudioPath && fs.existsSync(masterAudioPath)) {
        ffmpegArgs.push('-ss', startStamp, '-to', endStamp, '-i', masterAudioPath);
      }

      // Add filter & subtitle burn-in with PTS reset so t=0.000 matches clipStartMs
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      ffmpegArgs.push(
        '-vf',
        `setpts=PTS-STARTPTS,${adaptiveFilter},subtitles='${escapedAssPath}'`,
        '-af',
        'asetpts=PTS-STARTPTS',
        '-map',
        '0:v:0'
      );

      if (masterAudioPath && fs.existsSync(masterAudioPath)) {
        ffmpegArgs.push('-map', '1:a:0');
      } else {
        ffmpegArgs.push('-map', '0:a:0?');
      }

      ffmpegArgs.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-shortest',
        outputClipPath
      );

      await runFfmpegCommand(ffmpegArgs, 90000);

      // Verify output file size
      if (!fs.existsSync(outputClipPath) || fs.statSync(outputClipPath).size <= 0) {
        throw new Error(`FFmpeg output clip ${hook.clipId}.mp4 was not created or empty.`);
      }

      const signedUrl = signArtifactUrl(jobId, `${hook.clipId}.mp4`);

      renderedClips.push({
        index: i,
        clipId: hook.clipId,
        title: hook.title,
        engagementReasoning: hook.engagementReasoning,
        video_title_for_youtube_short: `${hook.title} #shorts`,
        video_description_for_tiktok: hook.engagementReasoning,
        video_description_for_instagram: `${hook.title} • 9:16 vertical reframing`,
        start: Number((hook.startMs / 1000).toFixed(3)),
        end: Number((hook.endMs / 1000).toFixed(3)),
        startMs: hook.startMs,
        endMs: hook.endMs,
        subtitles: clipSubtitles,
        wordCaptions,
        video_url: signedUrl,
        download_url: `${signedUrl}&download=1`,
        diskPath: outputClipPath,
      });
    }

    job.result = { clips: renderedClips };
    job.status = 'completed';
    job.stageMessage = 'Completed';
    job.logs.push(`[Completed] Successfully rendered ${renderedClips.length} vertical 9:16 clips.`);

    // Cleanup input staging directory immediately; outputArtifactDir is preserved for preview/download
    cleanupTempPaths([job.inputStagingDir]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pipeline execution failed.';
    job.status = 'failed';
    job.stageMessage = 'Failed';
    job.error = {
      code: 'PIPELINE_EXECUTION_ERROR',
      message,
    };
    job.logs.push(`[Error] ${message}`);
    cleanupTempPaths([job.inputStagingDir]);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Mount raw octet-stream body parser strictly for binary chunk uploads
  app.use(
    '/api/upload/chunk',
    express.raw({
      type: ['application/octet-stream', 'application/x-binary', '*/*'],
      limit: '16mb',
    })
  );

  // Standard JSON parser for other endpoints
  app.use(express.json({ limit: '16mb' }));

  // 1. Discovery Endpoint
  app.get('/api/me', (_req, res) => {
    res.json({
      plan: 'self-hosted',
      entitled: true,
      engine: 'mutonby/openshorts-lightweight-v2',
      architecture: 'frontend-driven-targeted-pipeline',
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      activeJobs: getActiveJobCount(),
      mediaEngine: {
        ffmpegAvailable: mediaEngine.ffmpegAvailable,
        ffprobeAvailable: mediaEngine.ffprobeAvailable,
        ffmpegVersion: mediaEngine.ffmpegVersion,
        ffprobeVersion: mediaEngine.ffprobeVersion,
      },
      gemini: {
        configured: Boolean(geminiConfig.apiKey),
        model: geminiConfig.model,
        status: geminiConfig.status,
      },
    });
  });

  // Gemini Settings Endpoints
  app.get('/api/settings/gemini', (_req, res) => {
    const hasKey = Boolean(geminiConfig.apiKey && geminiConfig.apiKey.trim());
    const maskedKey =
      geminiConfig.apiKey && geminiConfig.apiKey.length > 8
        ? `${geminiConfig.apiKey.slice(0, 6)}••••••••${geminiConfig.apiKey.slice(-4)}`
        : geminiConfig.apiKey
          ? '••••••••'
          : '';

    res.json({
      configured: hasKey,
      maskedKey,
      model: geminiConfig.model,
      supportedModels: SUPPORTED_GEMINI_MODELS,
      status: geminiConfig.status,
      statusMessage: geminiConfig.statusMessage,
      lastTestedAt: geminiConfig.lastTestedAt,
    });
  });

  app.post('/api/settings/gemini', async (req, res) => {
    const { apiKey, model } = req.body || {};
    let keyUpdated = false;

    if (typeof apiKey === 'string') {
      const trimmed = apiKey.trim();
      if (trimmed && trimmed !== geminiConfig.apiKey) {
        geminiConfig.apiKey = trimmed;
        keyUpdated = true;
      }
    }

    if (typeof model === 'string' && SUPPORTED_GEMINI_MODELS.some((m) => m.id === model)) {
      geminiConfig.model = model;
    }

    if (keyUpdated) {
      geminiConfig.status = 'not_configured';
      geminiConfig.statusMessage = 'API key saved. Click "Test Connection" to verify.';
      geminiConfig.lastTestedAt = undefined;
    }

    saveGeminiVault();

    const hasKey = Boolean(geminiConfig.apiKey && geminiConfig.apiKey.trim());
    const maskedKey =
      geminiConfig.apiKey && geminiConfig.apiKey.length > 8
        ? `${geminiConfig.apiKey.slice(0, 6)}••••••••${geminiConfig.apiKey.slice(-4)}`
        : geminiConfig.apiKey
          ? '••••••••'
          : '';

    res.json({
      success: true,
      configured: hasKey,
      maskedKey,
      model: geminiConfig.model,
      supportedModels: SUPPORTED_GEMINI_MODELS,
      status: geminiConfig.status,
      statusMessage: geminiConfig.statusMessage,
      lastTestedAt: geminiConfig.lastTestedAt,
    });
  });

  app.post('/api/settings/gemini/test', async (req, res) => {
    if (typeof req.body?.apiKey === 'string' && !req.body.apiKey.trim()) {
      res.status(400).json({
        success: false,
        status: 'not_configured',
        statusMessage: 'No API key provided to test.',
      });
      return;
    }

    const testKey =
      typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()
        ? req.body.apiKey.trim()
        : geminiConfig.apiKey;
    const testModel =
      typeof req.body?.model === 'string' &&
      SUPPORTED_GEMINI_MODELS.some((m) => m.id === req.body.model)
        ? req.body.model
        : geminiConfig.model;

    if (!testKey) {
      res.status(400).json({
        success: false,
        status: 'not_configured',
        statusMessage: 'No API key provided to test.',
      });
      return;
    }

    const testResult = await verifyGeminiKey(testKey, testModel);

    // If testing the saved key, persist the verified status to vault
    if (testKey === geminiConfig.apiKey) {
      geminiConfig.status = testResult.status;
      geminiConfig.statusMessage = testResult.statusMessage;
      geminiConfig.lastTestedAt = Date.now();
      saveGeminiVault();
    }

    res.json({
      success: testResult.success,
      status: testResult.status,
      statusMessage: testResult.statusMessage,
      model: testModel,
    });
  });

  app.delete('/api/settings/gemini', (_req, res) => {
    geminiConfig.apiKey = '';
    geminiConfig.status = 'not_configured';
    geminiConfig.statusMessage = 'Gemini API key cleared. Enter a new key in Settings to analyze transcripts.';
    geminiConfig.lastTestedAt = undefined;
    saveGeminiVault();

    res.json({
      success: true,
      configured: false,
      maskedKey: '',
      model: geminiConfig.model,
      status: 'not_configured',
      statusMessage: geminiConfig.statusMessage,
    });
  });

  // 2. Chunked Upload: Init (POST /api/upload/init)
  app.post('/api/upload/init', (req, res) => {
    const { fileName, mimeType, totalSizeBytes, kind } = req.body || {};
    if (!fileName || typeof totalSizeBytes !== 'number' || totalSizeBytes <= 0) {
      res.status(400).json({
        errorCode: 'INVALID_UPLOAD_INIT',
        detail: 'fileName and positive totalSizeBytes are required.',
      });
      return;
    }

    if (totalSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
      res.status(413).json({
        errorCode: 'FILE_TOO_LARGE',
        detail: `File size exceeds the ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB upload limit.`,
      });
      return;
    }

    const uploadId = `upl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const safeName = path.basename(String(fileName)).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadDir = path.join(STAGING_ROOT, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const tempFilePath = path.join(uploadDir, `${uploadId}_${safeName}`);

    // Pre-create empty file for positional pwrite
    fs.writeFileSync(tempFilePath, Buffer.alloc(0));

    const newSession: ChunkUploadSession = {
      uploadId,
      kind: kind === 'audio' ? 'audio' : 'video',
      fileName: safeName,
      mimeType: String(mimeType || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4')),
      totalSizeBytes,
      chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
      receivedChunks: new Map(),
      receivedBytes: 0,
      tempFilePath,
      verified: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    saveUploadSessionToDisk(newSession);

    res.json({
      uploadId,
      chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
      status: 'initialized',
    });
  });

  // 2. Chunked Upload: Raw Binary Chunk (POST /api/upload/chunk)
  app.post('/api/upload/chunk', (req, res) => {
    const uploadId = String(req.headers['x-upload-id'] || req.query.uploadId || '');
    const chunkIndex = Number(req.headers['x-chunk-index'] ?? req.query.chunkIndex ?? 0);
    const byteOffset = Number(req.headers['x-byte-offset'] ?? req.query.byteOffset ?? 0);

    const session = getOrRestoreUploadSession(uploadId);
    if (!session) {
      res.status(404).json({
        errorCode: 'UPLOAD_SESSION_NOT_FOUND',
        detail: 'Chunk upload session expired or does not exist.',
      });
      return;
    }

    session.lastActivityAt = Date.now();
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (buffer.byteLength === 0) {
      res.status(400).json({
        errorCode: 'EMPTY_CHUNK',
        detail: 'Binary request body is empty.',
      });
      return;
    }

    if (byteOffset < 0 || byteOffset + buffer.byteLength > session.totalSizeBytes) {
      res.status(413).json({
        errorCode: 'CHUNK_OUT_OF_BOUNDS',
        detail: `Chunk bounds (${byteOffset}..${byteOffset + buffer.byteLength}) exceed total file size (${session.totalSizeBytes}).`,
      });
      return;
    }

    // Idempotent chunk write using positional write (pwrite)
    try {
      const fd = fs.openSync(session.tempFilePath, 'r+');
      try {
        fs.writeSync(fd, buffer, 0, buffer.byteLength, byteOffset);
      } finally {
        fs.closeSync(fd);
      }

      session.receivedChunks.set(chunkIndex, {
        byteOffset,
        byteLength: buffer.byteLength,
      });

      // Compute total unique bytes received
      let total = 0;
      for (const chunk of session.receivedChunks.values()) {
        total += chunk.byteLength;
      }
      session.receivedBytes = total;
      saveUploadSessionToDisk(session);

      res.json({
        uploadId: session.uploadId,
        chunkIndex,
        receivedBytes: session.receivedBytes,
        totalSizeBytes: session.totalSizeBytes,
      });
    } catch (err) {
      res.status(500).json({
        errorCode: 'CHUNK_WRITE_FAILED',
        detail: 'Failed to write chunk to disk.',
      });
    }
  });

  // 2. Chunked Upload: Complete & FFprobe Verification (POST /api/upload/complete)
  app.post('/api/upload/complete', async (req, res) => {
    const { uploadId } = req.body || {};
    const session = getOrRestoreUploadSession(String(uploadId || ''));
    if (!session) {
      res.status(404).json({
        errorCode: 'UPLOAD_SESSION_NOT_FOUND',
        detail: 'Upload session does not exist.',
      });
      return;
    }

    if (!fs.existsSync(session.tempFilePath)) {
      res.status(404).json({
        errorCode: 'STAGED_FILE_MISSING',
        detail: 'Staged file missing from disk.',
      });
      return;
    }

    const actualDiskSize = fs.statSync(session.tempFilePath).size;
    if (actualDiskSize !== session.totalSizeBytes) {
      res.status(422).json({
        errorCode: 'INCOMPLETE_UPLOAD',
        detail: `Uploaded size (${actualDiskSize} bytes) does not match expected size (${session.totalSizeBytes} bytes).`,
      });
      return;
    }

    try {
      const probed = await probeMediaFile(session.tempFilePath);
      session.verified = true;
      session.probedDurationMs = probed.durationMs;
      session.probedWidth = probed.width;
      session.probedHeight = probed.height;
      saveUploadSessionToDisk(session);

      res.json({
        uploadId: session.uploadId,
        verified: true,
        fileName: session.fileName,
        sizeBytes: actualDiskSize,
        durationMs: probed.durationMs,
        width: probed.width,
        height: probed.height,
        format: probed.format,
      });
    } catch (probeErr) {
      res.status(422).json({
        errorCode: 'INVALID_MEDIA_CONTAINER',
        detail: probeErr instanceof Error ? probeErr.message : 'FFprobe could not parse media container.',
      });
    }
  });

  // 3. Process Endpoint (POST /api/process)
  app.post('/api/process', async (req, res) => {
    if (getActiveJobCount() >= MAX_CONCURRENT_JOBS) {
      res.status(429).json({
        errorCode: 'MAX_CONCURRENT_JOBS_EXCEEDED',
        detail: `Maximum concurrent jobs (${MAX_CONCURRENT_JOBS}) reached.`,
      });
      return;
    }

    const body = req.body || {};
    if (body.acknowledged === false) {
      res.status(400).json({
        errorCode: 'RIGHTS_NOT_ACKNOWLEDGED',
        detail: 'acknowledged: true rights attestation is required.',
      });
      return;
    }

    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    const videoUploadId = typeof body.videoUploadId === 'string' ? body.videoUploadId.trim() : '';
    const audioUploadId = typeof body.audioUploadId === 'string' ? body.audioUploadId.trim() : '';
    const transcriptText = typeof body.transcriptText === 'string' ? body.transcriptText : '';

    // Verify Master Audio Upload
    if (!audioUploadId) {
      res.status(422).json({
        errorCode: 'MISSING_MASTER_AUDIO',
        detail: 'Pre-extracted master audio binary must be uploaded via /api/upload/init + chunk.',
      });
      return;
    }

    const audioSession = getOrRestoreUploadSession(audioUploadId);
    if (!audioSession || !fs.existsSync(audioSession.tempFilePath)) {
      res.status(422).json({
        errorCode: 'MASTER_AUDIO_NOT_FOUND',
        detail: 'Uploaded master audio binary does not exist on disk.',
      });
      return;
    }

    let audioDurationMs = audioSession.probedDurationMs || 0;
    if (!audioDurationMs) {
      const p = await probeMediaFile(audioSession.tempFilePath);
      audioDurationMs = p.durationMs;
      audioSession.probedDurationMs = p.durationMs;
      saveUploadSessionToDisk(audioSession);
    }

    const masterAudio: MasterAudioPayload & { stagedPath: string } = {
      fileName: audioSession.fileName,
      format: audioSession.fileName.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3',
      sizeBytes: audioSession.totalSizeBytes,
      durationMs: audioDurationMs,
      stagedPath: audioSession.tempFilePath,
    };

    // Verify Video Source (Local Upload Session vs Remote URL)
    let videoDurationMs = 0;
    let inputMode: VideoInputMode = 'direct_url';
    let resolvedVideoUri = '';

    if (videoUploadId) {
      const videoSession = getOrRestoreUploadSession(videoUploadId);
      if (!videoSession || !fs.existsSync(videoSession.tempFilePath)) {
        res.status(422).json({
          errorCode: 'LOCAL_VIDEO_NOT_FOUND',
          detail: 'Uploaded local video binary does not exist on disk.',
        });
        return;
      }
      inputMode = 'local_upload';
      resolvedVideoUri = videoSession.tempFilePath;
      videoDurationMs = videoSession.probedDurationMs || 0;
      if (!videoDurationMs) {
        const p = await probeMediaFile(videoSession.tempFilePath);
        videoDurationMs = p.durationMs;
        videoSession.probedDurationMs = p.durationMs;
        saveUploadSessionToDisk(videoSession);
      }
    } else if (rawUrl) {
      const sourceValidation = validateSourceInput(rawUrl, null);
      if (!sourceValidation.valid || !sourceValidation.inputMode) {
        res.status(400).json({
          errorCode: sourceValidation.errorCode || 'INVALID_URL',
          detail: sourceValidation.errorMessage || 'Invalid video URL.',
        });
        return;
      }
      inputMode = sourceValidation.inputMode;

      // SSRF Validation, Stream Resolution & Video Stream Probe
      try {
        const safeStreamUrl =
          inputMode === 'youtube_url'
            ? await resolveYouTubeStreamUrl(rawUrl)
            : await resolveSafeExternalMediaUrl(rawUrl);
        resolvedVideoUri = safeStreamUrl;
        const p = await probeMediaFile(safeStreamUrl);
        if (p.durationMs <= 0 || p.width <= 0 || p.height <= 0) {
          throw new Error(
            'UNVERIFIED_VIDEO_STREAM: Remote source did not yield a valid video stream with verifiable dimensions and duration. Please upload a local video file (.mp4, .mov) or provide a supported direct media URL (.mp4, .mov, .webm).'
          );
        }
        videoDurationMs = p.durationMs;
      } catch (uErr) {
        const errMsg =
          uErr instanceof Error ? uErr.message : 'Could not access remote video stream safely.';
        const errorCode = errMsg.startsWith('YOUTUBE_EXTRACTION_BLOCKED')
          ? 'YOUTUBE_EXTRACTION_BLOCKED'
          : errMsg.startsWith('YOUTUBE_EXTRACTOR_UNAVAILABLE')
            ? 'YOUTUBE_EXTRACTOR_UNAVAILABLE'
            : errMsg.startsWith('REMOTE_URL_IS_HTML_WEBPAGE')
              ? 'REMOTE_URL_IS_HTML_WEBPAGE'
              : 'REMOTE_SOURCE_UNAVAILABLE';
        res.status(422).json({
          errorCode,
          detail: errMsg,
        });
        return;
      }
    } else {
      res.status(400).json({
        errorCode: 'MISSING_VIDEO_SOURCE',
        detail: 'Provide a valid video URL or upload a local video file.',
      });
      return;
    }

    // Validate Mandatory Pipeline Payloads & Duration Synchronization
    const payloadValidation = validateMandatoryPipelinePayloads({
      videoDurationMs,
      masterAudio,
      transcriptText,
    });

    if (!payloadValidation.valid) {
      res.status(422).json({
        errorCode: payloadValidation.errorCode || 'INVALID_FRONTEND_PAYLOADS',
        detail: payloadValidation.errorMessage || 'Transcript or master audio validation failed.',
      });
      return;
    }

    // Deduplication key
    const dedupeKey = crypto
      .createHash('sha256')
      .update(`${resolvedVideoUri}:${audioUploadId}:${transcriptText}`)
      .digest('hex')
      .slice(0, 16);

    for (const existing of jobs.values()) {
      if (
        existing.dedupeKey === dedupeKey &&
        (existing.status === 'queued' ||
          existing.status === 'validating' ||
          existing.status === 'analyzing' ||
          existing.status === 'extracting' ||
          existing.status === 'transcribing' ||
          existing.status === 'rendering')
      ) {
        res.json({
          job_id: existing.job_id,
          status: existing.status,
          deduplicated: true,
        });
        return;
      }
    }

    const unifiedSource = buildUnifiedMediaSource({
      inputMode,
      sourceUri: resolvedVideoUri,
      durationMs: videoDurationMs,
      supportsByteRange: true,
    });

    const jobId = `os_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const inputStagingDir = path.join(STAGING_ROOT, 'jobs', jobId, 'input');
    const outputArtifactDir = path.join(STAGING_ROOT, 'jobs', jobId, 'output');
    fs.mkdirSync(inputStagingDir, { recursive: true });
    fs.mkdirSync(outputArtifactDir, { recursive: true });

    jobs.set(jobId, {
      job_id: jobId,
      dedupeKey,
      status: 'queued',
      stageMessage: 'Queued',
      unifiedSource,
      masterAudio,
      transcriptCues: payloadValidation.cues,
      inputStagingDir,
      outputArtifactDir,
      tempFiles: [inputStagingDir],
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      activeStreamCount: 0,
      logs: [`[Job ${jobId}] Queued. Source=${inputMode}`],
      result: null,
    });

    setImmediate(() => {
      executeLightweightPipeline(jobId);
    });

    res.json({
      job_id: jobId,
      status: 'queued',
      unifiedSource,
    });
  });

  // 4. Job Polling (GET /api/status/:jobId)
  app.get('/api/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job) {
      res.status(404).json({
        errorCode: 'JOB_NOT_FOUND',
        detail: `Job ${jobId} not found or expired.`,
      });
      return;
    }

    job.lastAccessedAt = Date.now();
    res.json({
      job_id: job.job_id,
      status: job.status,
      stageMessage: job.stageMessage,
      unifiedSource: job.unifiedSource,
      logs: job.logs,
      result: job.result,
      error: job.error,
    });
  });

  // 5. Binary Artifact Delivery (GET /api/artifacts/:jobId/:clipFile)
  app.get('/api/artifacts/:jobId/:clipFile', (req, res) => {
    const rawJobId = String(req.params.jobId || '');
    const rawClipFile = String(req.params.clipFile || '');
    const jobId = path.basename(rawJobId).replace(/[^a-zA-Z0-9._-]/g, '');
    const clipFile = path.basename(rawClipFile).replace(/[^a-zA-Z0-9._-]/g, '');
    const expires = Number(req.query.expires || 0);
    const sig = String(req.query.sig || '');

    if (!jobId || !clipFile) {
      res.status(400).json({
        errorCode: 'INVALID_ARTIFACT_PATH',
        detail: 'Invalid artifact identifier.',
      });
      return;
    }

    if (expires || sig) {
      if (!expires || Date.now() > expires) {
        res.status(403).json({
          errorCode: 'URL_EXPIRED',
          detail: 'Temporary download URL has expired.',
        });
        return;
      }

      const expectedSig = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`${jobId}:${clipFile}:${expires}`)
        .digest('hex')
        .slice(0, 24);

      if (sig !== expectedSig) {
        res.status(403).json({
          errorCode: 'INVALID_SIGNATURE',
          detail: 'Invalid temporary artifact signature.',
        });
        return;
      }
    }

    const clipDiskPath = path.join(STAGING_ROOT, 'jobs', jobId, 'output', clipFile);
    const job = jobs.get(jobId);

    if (!fs.existsSync(clipDiskPath)) {
      res.status(404).json({
        errorCode: job ? 'ARTIFACT_NOT_FOUND' : 'JOB_NOT_FOUND',
        detail: job ? 'Rendered video artifact not found.' : 'Job does not exist or has expired.',
      });
      return;
    }

    // Reference count active streams to protect from premature cleanup
    if (job) {
      job.activeStreamCount++;
      job.lastAccessedAt = Date.now();
    }

    const onStreamEnd = () => {
      if (job) {
        job.activeStreamCount = Math.max(0, job.activeStreamCount - 1);
        job.lastAccessedAt = Date.now();
      }
    };

    res.once('finish', onStreamEnd);
    res.once('close', onStreamEnd);

    const isDownload = req.query.download === '1';
    const requestedName =
      typeof req.query.filename === 'string' && req.query.filename.trim()
        ? path.basename(req.query.filename.trim()).replace(/[^a-zA-Z0-9._-]/g, '_')
        : `fluxclip_${jobId}_${clipFile}`;
    const finalFileName = requestedName.toLowerCase().endsWith('.mp4')
      ? requestedName
      : `${requestedName}.mp4`;

    const stat = fs.statSync(clipDiskPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isDownload) {
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${finalFileName}"; filename*=UTF-8''${encodeURIComponent(finalFileName)}`
      );
      res.setHeader('Cache-Control', 'private, no-transform');
      const stream = fs.createReadStream(clipDiskPath);
      stream.pipe(res);
      return;
    }

    res.setHeader('Content-Disposition', `inline; filename="${finalFileName}"`);
    // Stream binary with native HTTP Range support for video preview player
    res.sendFile(clipDiskPath);
  });

  // Vite middleware for dev; static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FluxClip Studio + Lightweight OpenShorts Pipeline listening on http://localhost:${PORT}`);
  });
}

startServer();

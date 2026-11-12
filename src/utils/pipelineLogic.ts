export type NavigationTab = 'uploads' | 'clips';

export type VideoInputMode = 'youtube_url' | 'direct_url' | 'local_upload';

export type JobStage =
  | 'queued'
  | 'validating'
  | 'analyzing'
  | 'extracting'
  | 'transcribing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface LocalVideoFile {
  name: string;
  sizeBytes: number;
  mimeType: string;
  durationMs?: number;
  rawFile?: File;
  uploadedId?: string;
}

export interface TranscriptCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptPayload {
  fileName: string;
  format: 'srt' | 'txt';
  rawContent: string;
  cues: TranscriptCue[];
}

export interface MasterAudioPayload {
  fileName: string;
  format: 'mp3' | 'wav';
  sizeBytes: number;
  durationMs: number;
  rawFile?: File;
  uploadedId?: string;
}

export interface UnifiedMediaSource {
  sourceMode: VideoInputMode;
  originalUri: string;
  resolvedStreamUri: string;
  containerFormat: 'mp4' | 'mov' | 'webm' | 'mkv';
  durationMs: number;
  supportsByteRange: boolean;
  extractionStrategy: 'http_range_stream' | 'yt_dlp_targeted_stream' | 'chunked_local_staging';
}

export interface WordLevelCaption {
  word: string;
  startMs: number;
  endMs: number;
}

export interface GeminiViralMomentHook {
  clipId: string;
  startMs: number;
  endMs: number;
  title: string;
  engagementReasoning: string;
}

export interface ClipArtifact {
  id: string;
  index: number;
  label: string;
  title?: string;
  durationSeconds: number;
  currentSeconds: number;
  startMs: number;
  endMs: number;
  aspectRatio: '9:16';
  reframingMode: string;
  captionLines: [string, string];
  subtitles?: TranscriptCue[];
  engagementReasoning?: string;
  wordCaptions?: WordLevelCaption[];
  startTimestamp: string;
  endTimestamp: string;
  videoUrl?: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
}

export interface ValidationResult {
  valid: boolean;
  sourceType: 'url' | 'file' | null;
  inputMode?: VideoInputMode;
  normalizedSource: string;
  errorCode?:
    | 'MISSING_VIDEO_SOURCE'
    | 'INVALID_URL'
    | 'UNSUPPORTED_VIDEO_FORMAT'
    | 'FILE_TOO_LARGE'
    | 'MISSING_TRANSCRIPT'
    | 'INVALID_TRANSCRIPT_TIMECODES'
    | 'MISSING_MASTER_AUDIO'
    | 'UNSUPPORTED_AUDIO_FORMAT'
    | 'AUDIO_VIDEO_DURATION_MISMATCH'
    | 'TRANSCRIPT_OUT_OF_BOUNDS';
  errorMessage?: string;
}

const MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024; // 512MB strict mobile chunked upload limit
const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm'];
const DIRECT_STREAM_EXTENSIONS = ['.mp4', '.mov', '.webm'];
const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav'];
const AV_SYNC_TOLERANCE_MS = 2500; // 2.5s max drift between master audio and video container
const NON_FINAL_CUE_TOLERANCE_MS = 1000; // 1.0s max drift on intermediate cues
const FINAL_CUE_TRAILING_TOLERANCE_MS = 5000; // 5.0s max trailing caption hold ONLY on the final transcript cue

export function isHtmlOrWebpageContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('application/xhtml+xml');
}

export function clampHookToMediaDuration(
  hook: GeminiViralMomentHook,
  actualMediaDurationMs: number
): GeminiViralMomentHook | null {
  if (actualMediaDurationMs <= 0) return hook;
  if (hook.startMs < 0 || hook.startMs >= actualMediaDurationMs) {
    return null;
  }
  const clampedStartMs = Math.max(0, Math.round(hook.startMs));
  const clampedEndMs = Math.min(actualMediaDurationMs, Math.round(hook.endMs));
  if (clampedEndMs <= clampedStartMs) {
    return null;
  }
  return {
    ...hook,
    startMs: clampedStartMs,
    endMs: clampedEndMs,
  };
}

export function classifyYouTubeExtractionFailure(rawError: string): {
  errorCode: 'YOUTUBE_EXTRACTION_BLOCKED' | 'YOUTUBE_EXTRACTOR_UNAVAILABLE';
  userMessage: string;
} {
  const msg = (rawError || '').toLowerCase();
  if (msg.includes('enoent') || msg.includes('not found') || msg.includes('unavailable in deployment')) {
    return {
      errorCode: 'YOUTUBE_EXTRACTOR_UNAVAILABLE',
      userMessage:
        'YouTube stream extractor is unavailable in this environment. Please upload the video as a local MP4/MOV file or provide a supported direct media URL (.mp4, .mov, .webm).',
    };
  }
  if (
    msg.includes('not a bot') ||
    msg.includes('sign in') ||
    msg.includes('cookies') ||
    msg.includes('age') ||
    msg.includes('private') ||
    msg.includes('drm') ||
    msg.includes('members-only') ||
    msg.includes('403')
  ) {
    return {
      errorCode: 'YOUTUBE_EXTRACTION_BLOCKED',
      userMessage:
        'YouTube restricted automated access to this video stream (access control / bot protection). Please upload the video as a local MP4/MOV file or provide a supported direct media URL (.mp4, .mov, .webm).',
    };
  }
  return {
    errorCode: 'YOUTUBE_EXTRACTION_BLOCKED',
    userMessage:
      'Could not extract a direct video stream from this YouTube URL. Please upload a local video file (.mp4, .mov) or use a supported direct media URL (.mp4, .mov, .webm).',
  };
}

/**
 * Parses HH:MM:SS,mmm or HH:MM:SS.mmm or MM:SS.mmm into milliseconds.
 */
export function parseTimecodeToMs(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  let hours = 0;
  let minutes = 0;
  let secondsFloat = 0;

  if (parts.length === 3) {
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    secondsFloat = Number(parts[2]);
  } else {
    minutes = Number(parts[0]);
    secondsFloat = Number(parts[1]);
  }

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(secondsFloat) ||
    hours < 0 ||
    minutes < 0 ||
    minutes >= 60 ||
    secondsFloat < 0 ||
    secondsFloat >= 60
  ) {
    return null;
  }

  return Math.round((hours * 3600 + minutes * 60 + secondsFloat) * 1000);
}

/**
 * Formats milliseconds into HH:MM:SS.mmm
 */
export function formatMsToTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(clamped / 1000);
  const millis = clamped % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${millis
    .toString()
    .padStart(3, '0')}`;
}

/**
 * Parses a manual .srt or timestamped .txt transcript into validated millisecond cues.
 */
export function parseTimecodedTranscript(rawText: string): {
  valid: boolean;
  cues: TranscriptCue[];
  errorMessage?: string;
} {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      valid: false,
      cues: [],
      errorMessage: 'Manual transcript (.srt or .txt) with pre-existing timecodes is required.',
    };
  }

  const cues: TranscriptCue[] = [];
  const normalized = trimmed.replace(/\r\n/g, '\n');

  const blocks = normalized.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const arrowLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowLineIdx !== -1) {
      const timeLine = lines[arrowLineIdx];
      const match = timeLine.match(
        /(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(.*)/
      );
      if (!match) {
        return {
          valid: false,
          cues: [],
          errorMessage: `Malformed timecode line in transcript: "${timeLine}"`,
        };
      }
      const startMs = parseTimecodeToMs(match[1]);
      const endMs = parseTimecodeToMs(match[2]);
      const inlineText = match[3]?.trim() || '';
      const bodyText = lines
        .slice(arrowLineIdx + 1)
        .join(' ')
        .trim();
      const text = [inlineText, bodyText].filter(Boolean).join(' ').trim();

      if (startMs === null || endMs === null || endMs <= startMs || !text) {
        return {
          valid: false,
          cues: [],
          errorMessage: `Invalid timecode interval or empty text near "${timeLine}".`,
        };
      }
      cues.push({
        index: cues.length + 1,
        startMs,
        endMs,
        text,
      });
    } else {
      for (const line of lines) {
        const txtMatch = line.match(
          /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-|-->|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/i
        );
        if (!txtMatch) {
          return {
            valid: false,
            cues: [],
            errorMessage: `Missing exact timecodes on transcript line: "${line.slice(0, 48)}"`,
          };
        }
        const startMs = parseTimecodeToMs(txtMatch[1]);
        const endMs = parseTimecodeToMs(txtMatch[2]);
        const text = txtMatch[3].trim();
        if (startMs === null || endMs === null || endMs <= startMs || !text) {
          return {
            valid: false,
            cues: [],
            errorMessage: `Invalid timecode range in line: "${line.slice(0, 48)}"`,
          };
        }
        cues.push({
          index: cues.length + 1,
          startMs,
          endMs,
          text,
        });
      }
    }
  }

  if (cues.length === 0) {
    return {
      valid: false,
      cues: [],
      errorMessage: 'No valid timecoded segments found in manual transcript.',
    };
  }

  return { valid: true, cues };
}

/**
 * Classifies a remote URL into 'youtube_url' or 'direct_url' (.mp4, .mov, .webm) and validates it.
 */
export function classifyRemoteVideoUrl(rawUrl: string): {
  valid: boolean;
  inputMode?: 'youtube_url' | 'direct_url';
  normalizedUrl: string;
  containerFormat?: 'mp4' | 'mov' | 'webm';
  errorMessage?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalizedUrl: '',
      errorMessage: 'Paste a valid YouTube or Direct Video URL (.mp4, .mov, .webm).',
    };
  }

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return {
        valid: false,
        normalizedUrl: '',
        errorMessage: 'Enter a valid streaming or direct video URL.',
      };
    }

    const host = parsed.hostname.toLowerCase();
    const isYouTube =
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be';

    if (isYouTube) {
      return {
        valid: true,
        inputMode: 'youtube_url',
        normalizedUrl: parsed.toString(),
        containerFormat: 'mp4',
      };
    }

    const lowerPath = parsed.pathname.toLowerCase();
    const matchedDirectExt = DIRECT_STREAM_EXTENSIONS.find((ext) => lowerPath.endsWith(ext));
    if (matchedDirectExt) {
      return {
        valid: true,
        inputMode: 'direct_url',
        normalizedUrl: parsed.toString(),
        containerFormat: matchedDirectExt.slice(1) as 'mp4' | 'mov' | 'webm',
      };
    }

    return {
      valid: true,
      inputMode: 'direct_url',
      normalizedUrl: parsed.toString(),
      containerFormat: 'mp4',
    };
  } catch {
    return {
      valid: false,
      normalizedUrl: '',
      errorMessage: 'Enter a valid YouTube or Direct Video URL.',
    };
  }
}

/**
 * Creates a UnifiedMediaSource abstraction so the downstream FFmpeg pipeline treats
 * Direct Video URLs, Local Video Uploads, and YouTube URLs identically.
 */
export function buildUnifiedMediaSource(params: {
  inputMode: VideoInputMode;
  sourceUri: string;
  durationMs: number;
  supportsByteRange?: boolean;
}): UnifiedMediaSource {
  const lower = params.sourceUri.toLowerCase();
  const containerFormat: 'mp4' | 'mov' | 'webm' | 'mkv' = lower.endsWith('.mov')
    ? 'mov'
    : lower.endsWith('.webm')
      ? 'webm'
      : lower.endsWith('.mkv')
        ? 'mkv'
        : 'mp4';

  if (params.inputMode === 'youtube_url') {
    return {
      sourceMode: 'youtube_url',
      originalUri: params.sourceUri,
      resolvedStreamUri: params.sourceUri,
      containerFormat: 'mp4',
      durationMs: params.durationMs,
      supportsByteRange: true,
      extractionStrategy: 'yt_dlp_targeted_stream',
    };
  }

  if (params.inputMode === 'local_upload') {
    return {
      sourceMode: 'local_upload',
      originalUri: params.sourceUri,
      resolvedStreamUri: params.sourceUri,
      containerFormat,
      durationMs: params.durationMs,
      supportsByteRange: true,
      extractionStrategy: 'chunked_local_staging',
    };
  }

  return {
    sourceMode: 'direct_url',
    originalUri: params.sourceUri,
    resolvedStreamUri: params.sourceUri,
    containerFormat,
    durationMs: params.durationMs,
    supportsByteRange: params.supportsByteRange ?? true,
    extractionStrategy: 'http_range_stream',
  };
}

/**
 * Generates an adaptive 9:16 video filter chain based on input dimensions.
 * Ensures all width and height pixel dimensions are even for libx264 yuv420p.
 */
export function buildAdaptive9x16VideoFilter(params: {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth?: number;
  targetHeight?: number;
}): string {
  const targetW = params.targetWidth || 720;
  const targetH = params.targetHeight || 1280;
  const srcW = params.sourceWidth > 0 ? params.sourceWidth : 1920;
  const srcH = params.sourceHeight > 0 ? params.sourceHeight : 1080;

  const targetAspect = targetW / targetH; // 9/16 = 0.5625
  const srcAspect = srcW / srcH;

  // Case 1: Already 9:16 (within 1% tolerance)
  if (Math.abs(srcAspect - targetAspect) < 0.01) {
    return `scale=${targetW}:${targetH},setsar=1`;
  }

  // Case 2: Wider than 9:16 (landscape 16:9, 4:3, 1:1, etc.)
  if (srcAspect > targetAspect) {
    return `crop='trunc(ih*9/16/2)*2:trunc(ih/2)*2:(iw-trunc(ih*9/16/2)*2)/2:0',scale=${targetW}:${targetH},setsar=1`;
  }

  // Case 3: Narrower than 9:16 (extreme vertical)
  return `crop='trunc(iw/2)*2:trunc(iw*16/9/2)*2:0:(ih-trunc(iw*16/9/2)*2)/2',scale=${targetW}:${targetH},setsar=1`;
}

/**
 * Validates audio/video duration synchronization and transcript timecode bounds.
 */
export function validateMandatoryPipelinePayloads(params: {
  videoDurationMs: number;
  masterAudio: MasterAudioPayload | null;
  transcriptText: string;
}): {
  valid: boolean;
  cues: TranscriptCue[];
  errorCode?: ValidationResult['errorCode'];
  errorMessage?: string;
} {
  const { videoDurationMs, masterAudio, transcriptText } = params;

  const parsedTranscript = parseTimecodedTranscript(transcriptText);
  if (!parsedTranscript.valid) {
    return {
      valid: false,
      cues: [],
      errorCode: transcriptText.trim() ? 'INVALID_TRANSCRIPT_TIMECODES' : 'MISSING_TRANSCRIPT',
      errorMessage: parsedTranscript.errorMessage,
    };
  }

  if (!masterAudio) {
    return {
      valid: false,
      cues: [],
      errorCode: 'MISSING_MASTER_AUDIO',
      errorMessage: 'Pre-extracted master audio (.mp3 or .wav) is required.',
    };
  }

  const lowerAudio = masterAudio.fileName.toLowerCase();
  const validAudioExt = ALLOWED_AUDIO_EXTENSIONS.some((ext) => lowerAudio.endsWith(ext));
  if (!validAudioExt) {
    return {
      valid: false,
      cues: [],
      errorCode: 'UNSUPPORTED_AUDIO_FORMAT',
      errorMessage: 'Master audio must be in .mp3 or .wav format.',
    };
  }

  if (
    videoDurationMs > 0 &&
    masterAudio.durationMs > 0 &&
    Math.abs(masterAudio.durationMs - videoDurationMs) > AV_SYNC_TOLERANCE_MS
  ) {
    return {
      valid: false,
      cues: [],
      errorCode: 'AUDIO_VIDEO_DURATION_MISMATCH',
      errorMessage: `Master audio duration (${formatMsToTimestamp(
        masterAudio.durationMs
      )}) does not match video duration (${formatMsToTimestamp(videoDurationMs)}).`,
    };
  }

  const actualMediaEndMs = videoDurationMs > 0 ? videoDurationMs : masterAudio.durationMs;
  const effectiveDurationMs = Math.max(videoDurationMs, masterAudio.durationMs);
  if (effectiveDurationMs > 0) {
    const totalCues = parsedTranscript.cues.length;
    for (let idx = 0; idx < totalCues; idx++) {
      const cue = parsedTranscript.cues[idx];
      const isFinalCue = idx === totalCues - 1;

      if (actualMediaEndMs > 0 && cue.startMs >= actualMediaEndMs) {
        return {
          valid: false,
          cues: [],
          errorCode: 'TRANSCRIPT_OUT_OF_BOUNDS',
          errorMessage: `Transcript cue #${cue.index} starts at ${formatMsToTimestamp(
            cue.startMs
          )}, after media ends (${formatMsToTimestamp(actualMediaEndMs)}).`,
        };
      }

      const maxAllowedEndMs =
        effectiveDurationMs +
        (isFinalCue ? FINAL_CUE_TRAILING_TOLERANCE_MS : NON_FINAL_CUE_TOLERANCE_MS);

      if (cue.endMs > maxAllowedEndMs) {
        return {
          valid: false,
          cues: [],
          errorCode: 'TRANSCRIPT_OUT_OF_BOUNDS',
          errorMessage: `Transcript cue #${cue.index} ends at ${formatMsToTimestamp(
            cue.endMs
          )}, exceeding media duration (${formatMsToTimestamp(effectiveDurationMs)}).`,
        };
      }
    }
  }

  return {
    valid: true,
    cues: parsedTranscript.cues,
  };
}

export function validateSourceInput(
  rawUrl: string,
  localFile: LocalVideoFile | null
): ValidationResult {
  if (localFile) {
    if (localFile.sizeBytes <= 0) {
      return {
        valid: false,
        sourceType: null,
        normalizedSource: '',
        errorCode: 'MISSING_VIDEO_SOURCE',
        errorMessage: 'Selected video file is empty.',
      };
    }
    if (localFile.sizeBytes > MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        sourceType: null,
        normalizedSource: '',
        errorCode: 'FILE_TOO_LARGE',
        errorMessage: 'Local file exceeds the 512MB mobile chunked upload limit.',
      };
    }
    const lowerName = localFile.name.toLowerCase();
    const hasAllowedExt = ALLOWED_VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    const hasVideoMime = localFile.mimeType.startsWith('video/');
    if (!hasAllowedExt && !hasVideoMime) {
      return {
        valid: false,
        sourceType: null,
        normalizedSource: '',
        errorCode: 'UNSUPPORTED_VIDEO_FORMAT',
        errorMessage: 'Unsupported container. Choose MP4, MOV, MKV, or WebM.',
      };
    }
    return {
      valid: true,
      sourceType: 'file',
      inputMode: 'local_upload',
      normalizedSource: localFile.name,
    };
  }

  const urlClassification = classifyRemoteVideoUrl(rawUrl);
  if (!urlClassification.valid) {
    return {
      valid: false,
      sourceType: null,
      normalizedSource: '',
      errorCode: rawUrl.trim() ? 'INVALID_URL' : 'MISSING_VIDEO_SOURCE',
      errorMessage:
        urlClassification.errorMessage ||
        'Paste a valid video URL or select a local video file first.',
    };
  }

  return {
    valid: true,
    sourceType: 'url',
    inputMode: urlClassification.inputMode,
    normalizedSource: urlClassification.normalizedUrl,
  };
}

export function formatClockTime(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatSegmentTitle(clip: ClipArtifact): string {
  return `Clip ${clip.index} • ${clip.aspectRatio} ${clip.reframingMode}`;
}

export function formatSegmentDurationLabel(clip: ClipArtifact): string {
  return `${clip.durationSeconds} seconds`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extracts original transcript cues overlapping [clipStartMs, clipEndMs] and converts
 * their timestamps into clip-relative milliseconds:
 *   clipRelativeTime = originalCueTime - clipStartTime
 * Cues crossing clip boundaries have their display interval clamped to [0, clipDurationMs]
 * while preserving the original transcript wording verbatim.
 */
export function extractClipRelativeSubtitles(
  cues: TranscriptCue[],
  clipStartMs: number,
  clipEndMs: number
): TranscriptCue[] {
  const clipDurationMs = Math.max(0, Math.round(clipEndMs - clipStartMs));
  if (clipDurationMs <= 0 || !Array.isArray(cues) || cues.length === 0) {
    return [];
  }

  const selected: TranscriptCue[] = [];
  for (const cue of cues) {
    if (cue.endMs <= clipStartMs || cue.startMs >= clipEndMs) {
      continue;
    }

    const relStartMs = Math.max(0, Math.min(clipDurationMs, Math.round(cue.startMs - clipStartMs)));
    const relEndMs = Math.max(0, Math.min(clipDurationMs, Math.round(cue.endMs - clipStartMs)));
    if (relEndMs <= relStartMs) {
      continue;
    }

    selected.push({
      index: cue.index,
      startMs: relStartMs,
      endMs: relEndMs,
      text: cue.text,
    });
  }

  return selected;
}

export interface AudioEnergyEnvelope {
  /** Frame step in milliseconds (default 10ms) */
  frameDurationMs: number;
  /** Normalized RMS + speech activity energy per frame [0..1] */
  rmsFrames: number[];
  /** Total duration covered by the envelope in milliseconds */
  durationMs: number;
}

export interface WordProsodicProfile {
  word: string;
  /** Estimated relative acoustic spoken weight (syllables, matras, stretched vowels) */
  spokenWeight: number;
  /** Relative post-word pause demand from clause/sentence punctuation */
  pauseAfterWeight: number;
  /** True if the word ends with a clause or sentence pause marker */
  hasPausePunctuation: boolean;
}

/**
 * Converts a raw 16-bit signed little-endian mono PCM audio buffer (e.g. from FFmpeg -f s16le -ac 1 -ar 8000)
 * into a high-resolution (10ms) acoustic speech activity envelope combining RMS energy and zero-crossing flux.
 */
export function extractPcmS16LeRmsEnvelope(
  pcmBytes: Uint8Array,
  sampleRate = 8000,
  frameDurationMs = 10
): AudioEnergyEnvelope {
  const safeFrameMs = Math.max(5, Math.round(frameDurationMs));
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * safeFrameMs) / 1000));
  const totalSamples = Math.floor(pcmBytes.byteLength / 2);
  if (totalSamples <= 0) {
    return { frameDurationMs: safeFrameMs, rmsFrames: [], durationMs: 0 };
  }

  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  const numFrames = Math.ceil(totalSamples / samplesPerFrame);
  const rmsFrames: number[] = new Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const startSample = f * samplesPerFrame;
    const endSample = Math.min(totalSamples, startSample + samplesPerFrame);
    const count = endSample - startSample;
    if (count <= 0) {
      rmsFrames[f] = 0;
      continue;
    }

    let sumSq = 0;
    let diffSum = 0;
    let prev = view.getInt16(startSample * 2, true) / 32768;
    for (let s = startSample; s < endSample; s++) {
      const sample = view.getInt16(s * 2, true) / 32768;
      sumSq += sample * sample;
      diffSum += Math.abs(sample - prev);
      prev = sample;
    }

    const rms = Math.sqrt(sumSq / count);
    const hfFlux = (diffSum / count) * 0.35;
    rmsFrames[f] = Math.min(1, rms + hfFlux);
  }

  return {
    frameDurationMs: safeFrameMs,
    rmsFrames,
    durationMs: Math.round((totalSamples / sampleRate) * 1000),
  };
}

const SHORT_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'of', 'at', 'by', 'is', 'it', 'as', 'or', 'be', 'do', 'go', 'so', 'we', 'he', 'me', 'my',
  'को', 'में', 'से', 'पर', 'की', 'का', 'के', 'ने', 'तो', 'भी', 'ही', 'ये', 'वो', 'ना', 'है', 'हूँ', 'था', 'थी', 'थे',
]);

/**
 * Computes phonetic syllable weight and post-word punctuation pause weight for English (Latin),
 * Hindi (Devanagari), and mixed speech words, including stretched vowels and emphasis.
 */
export function computeWordAcousticProsodicProfile(
  rawWord: string,
  isLastWordInCue: boolean
): WordProsodicProfile {
  const trimmed = rawWord.trim();
  if (!trimmed) {
    return { word: rawWord, spokenWeight: 1, pauseAfterWeight: 0, hasPausePunctuation: false };
  }

  // Detect trailing punctuation for pause modeling
  const hasEllipsis = /(?:\.\.\.|…|--+|—+)$/.test(trimmed);
  const hasSentenceEnd = /[.?!।॥]+['"”’)\]]*$/.test(trimmed);
  const hasClauseBreak = /[,;:–-]+['"”’)\]]*$/.test(trimmed);
  const hasPausePunctuation = hasEllipsis || hasSentenceEnd || hasClauseBreak;

  let pauseAfterWeight = 0.06;
  if (!isLastWordInCue) {
    if (hasEllipsis) {
      pauseAfterWeight = 1.65;
    } else if (hasSentenceEnd) {
      pauseAfterWeight = 1.35;
    } else if (hasClauseBreak) {
      pauseAfterWeight = 0.78;
    }
  }

  // Strip punctuation to analyze phonetic core
  const cleanCore = trimmed.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
  if (!cleanCore) {
    return { word: rawWord, spokenWeight: 0.6, pauseAfterWeight, hasPausePunctuation };
  }

  const hasDevanagari = /[\u0900-\u097F]/.test(cleanCore);
  let phoneticUnits = 0;

  if (hasDevanagari) {
    // Count Devanagari aksharas, long vowel matras, and nasal/visarga modifiers
    const codePoints = Array.from(cleanCore);
    for (let i = 0; i < codePoints.length; i++) {
      const cp = codePoints[i].codePointAt(0) || 0;
      const nextCp = i + 1 < codePoints.length ? codePoints[i + 1].codePointAt(0) || 0 : 0;

      // Independent vowels (अ - औ)
      if (cp >= 0x0904 && cp <= 0x0914) {
        const isLongVowel =
          cp === 0x0906 || cp === 0x0908 || cp === 0x090a || (cp >= 0x090f && cp <= 0x0914);
        phoneticUnits += isLongVowel ? 1.35 : 1.0;
      } else if ((cp >= 0x0915 && cp <= 0x0939) || (cp >= 0x0958 && cp <= 0x095f)) {
        // Consonant: if followed by halant/virama (0x094D), it forms a half-consonant cluster
        if (nextCp === 0x094d) {
          phoneticUnits += 0.38;
        } else {
          phoneticUnits += 0.95;
        }
      } else if (
        cp === 0x093e || // ा
        cp === 0x0940 || // ी
        cp === 0x0942 || // ू
        cp === 0x0947 || // े
        cp === 0x0948 || // ै
        cp === 0x094b || // ो
        cp === 0x094c    // ौ
      ) {
        // Long vowel matra adds acoustic hold duration
        phoneticUnits += 0.42;
      } else if (cp === 0x093f || cp === 0x0941 || cp === 0x0943) {
        // Short vowel matra (ि, ु, ृ)
        phoneticUnits += 0.12;
      } else if (cp >= 0x0901 && cp <= 0x0903) {
        // Chandrabindu, anusvara, visarga
        phoneticUnits += 0.24;
      } else if (/[a-zA-Z0-9]/.test(codePoints[i])) {
        phoneticUnits += 0.35;
      }
    }
  } else {
    // English / Latin syllable & character length model
    const lower = cleanCore.toLowerCase();
    // Collapse stretched repeated characters first to count base syllables, then add stretch bonus
    const collapsed = lower.replace(/(.)\1{2,}/g, '$1$1');
    const vowelGroups = collapsed.match(/[aeiouy]+/g);
    let syllables = vowelGroups ? vowelGroups.length : 1;
    if (collapsed.length > 3 && collapsed.endsWith('e') && !collapsed.endsWith('le') && syllables > 1) {
      syllables -= 1;
    }
    phoneticUnits = Math.max(0.8, syllables * 0.72 + collapsed.length * 0.09);
  }

  // Detect stretched / elongated words (e.g., "sooooo", "noooo", "waaaait", "अरेरेरे")
  const stretchedMatches = cleanCore.match(/(.)\1{2,}/gu);
  if (stretchedMatches) {
    for (const run of stretchedMatches) {
      const extraChars = Math.max(0, Array.from(run).length - 2);
      phoneticUnits += extraChars * 0.65;
    }
  }

  let spokenWeight = Math.max(0.65, phoneticUnits);
  if (SHORT_FUNCTION_WORDS.has(cleanCore.toLowerCase()) && !hasPausePunctuation && !isLastWordInCue) {
    spokenWeight *= 0.78;
  }

  // Pre-boundary / sentence-final lengthening & emphasis
  if (hasSentenceEnd || hasEllipsis || isLastWordInCue) {
    spokenWeight *= 1.16;
  } else if (hasClauseBreak) {
    spokenWeight *= 1.08;
  }

  return {
    word: rawWord,
    spokenWeight,
    pauseAfterWeight,
    hasPausePunctuation,
  };
}

/**
 * Aligns a single cue's words against the actual acoustic energy envelope (when provided)
 * and phonetic/prosodic speech profiles, handling short/long pauses, fast/slow speech,
 * stretched words, and Hindi/English/mixed utterances without altering original words.
 */
export function alignCueWordsWithAudioAndProsody(
  cue: TranscriptCue,
  audioEnvelope?: AudioEnergyEnvelope
): WordLevelCaption[] {
  const words = cue.text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0 || cue.endMs <= cue.startMs) {
    return [];
  }

  const cueStartMs = cue.startMs;
  const cueEndMs = cue.endMs;
  const cueSpanMs = Math.max(1, cueEndMs - cueStartMs);

  if (words.length === 1) {
    return [{ word: words[0], startMs: cueStartMs, endMs: cueEndMs }];
  }

  const profiles = words.map((w, idx) =>
    computeWordAcousticProsodicProfile(w, idx === words.length - 1)
  );

  // Check if we have a usable acoustic envelope covering this cue window
  const frameMs = audioEnvelope?.frameDurationMs || 10;
  const startFrameIdx = Math.max(0, Math.floor(cueStartMs / frameMs));
  const endFrameIdx = audioEnvelope
    ? Math.min(audioEnvelope.rmsFrames.length, Math.ceil(cueEndMs / frameMs))
    : 0;
  const numCueFrames = endFrameIdx - startFrameIdx;

  if (audioEnvelope && numCueFrames >= Math.max(4, words.length)) {
    const rawSlice = audioEnvelope.rmsFrames.slice(startFrameIdx, endFrameIdx);
    // Smooth 10ms frames with a 3-tap filter [0.25, 0.5, 0.25]
    const smoothed: number[] = new Array(rawSlice.length);
    for (let i = 0; i < rawSlice.length; i++) {
      const prev = i > 0 ? rawSlice[i - 1] : rawSlice[i];
      const next = i + 1 < rawSlice.length ? rawSlice[i + 1] : rawSlice[i];
      smoothed[i] = 0.25 * prev + 0.5 * rawSlice[i] + 0.25 * next;
    }

    const sorted = [...smoothed].sort((a, b) => a - b);
    const floorE = sorted[Math.floor(sorted.length * 0.12)] ?? 0;
    const peakE = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const dynamicRange = peakE - floorE;

    if (dynamicRange > 0.015) {
      const vadThreshold = floorE + dynamicRange * 0.2;
      const isSpeech: boolean[] = smoothed.map((e) => e >= vadThreshold);

      // Bridge micro stop-consonant closures (<= 3 frames / 30ms)
      const maxBridgeFrames = Math.max(1, Math.round(30 / frameMs));
      let gapRun = 0;
      for (let i = 0; i < isSpeech.length; i++) {
        if (!isSpeech[i]) {
          gapRun++;
        } else {
          if (gapRun > 0 && gapRun <= maxBridgeFrames && i - gapRun > 0) {
            for (let j = i - gapRun; j < i; j++) {
              isSpeech[j] = true;
            }
          }
          gapRun = 0;
        }
      }

      // Extract contiguous speech islands [startFrame, endFrame)
      interface SpeechIsland {
        startFrame: number;
        endFrame: number;
        startMs: number;
        endMs: number;
        energyWeight: number;
      }
      const rawIslands: SpeechIsland[] = [];
      let inIsland = false;
      let islStart = 0;
      for (let i = 0; i <= isSpeech.length; i++) {
        const active = i < isSpeech.length ? isSpeech[i] : false;
        if (active && !inIsland) {
          inIsland = true;
          islStart = i;
        } else if (!active && inIsland) {
          inIsland = false;
          const islEnd = i;
          if (islEnd - islStart >= 2) {
            let energySum = 0;
            for (let f = islStart; f < islEnd; f++) {
              energySum += Math.max(0.01, smoothed[f] - floorE);
            }
            const sMs = Math.max(cueStartMs, Math.min(cueEndMs, cueStartMs + islStart * frameMs));
            const eMs = Math.max(sMs + frameMs, Math.min(cueEndMs, cueStartMs + islEnd * frameMs));
            rawIslands.push({
              startFrame: islStart,
              endFrame: islEnd,
              startMs: sMs,
              endMs: eMs,
              energyWeight: energySum * 0.65 + ((eMs - sMs) / frameMs) * dynamicRange * 0.35,
            });
          }
        }
      }

      // If more islands than words (e.g. intra-word syllable dips), iteratively merge islands separated by the smallest gap
      const islands = [...rawIslands];
      while (islands.length > words.length) {
        let minGapMs = Infinity;
        let mergeIdx = 0;
        for (let i = 0; i < islands.length - 1; i++) {
          const gapMs = islands[i + 1].startMs - islands[i].endMs;
          if (gapMs < minGapMs) {
            minGapMs = gapMs;
            mergeIdx = i;
          }
        }
        const merged: SpeechIsland = {
          startFrame: islands[mergeIdx].startFrame,
          endFrame: islands[mergeIdx + 1].endFrame,
          startMs: islands[mergeIdx].startMs,
          endMs: islands[mergeIdx + 1].endMs,
          energyWeight: islands[mergeIdx].energyWeight + islands[mergeIdx + 1].energyWeight,
        };
        islands.splice(mergeIdx, 2, merged);
      }

      if (islands.length >= 1) {
        const K = islands.length;
        const N = words.length;

        // Partition N words into K non-empty contiguous groups matching island acoustic weight + punctuation pauses
        const totalWordWeight = profiles.reduce((acc, p) => acc + p.spokenWeight, 0) || 1;
        const totalIslandWeight = islands.reduce((acc, isl) => acc + isl.energyWeight, 0) || 1;

        // DP table: dp[k][n] = min cost to assign first n words (0..n-1) to first k islands (0..k-1)
        const dp: number[][] = Array.from({ length: K + 1 }, () =>
          new Array(N + 1).fill(Infinity)
        );
        const parent: number[][] = Array.from({ length: K + 1 }, () =>
          new Array(N + 1).fill(0)
        );
        dp[0][0] = 0;

        for (let k = 1; k <= K; k++) {
          const islFraction = islands[k - 1].energyWeight / totalIslandWeight;
          const pauseAfterIslandMs =
            k < K ? Math.max(0, islands[k].startMs - islands[k - 1].endMs) : 0;

          for (let n = k; n <= N - (K - k); n++) {
            for (let prevN = k - 1; prevN < n; prevN++) {
              let groupWeight = 0;
              for (let wIdx = prevN; wIdx < n; wIdx++) {
                groupWeight += profiles[wIdx].spokenWeight;
              }
              const wordFraction = groupWeight / totalWordWeight;
              let cost = Math.pow(wordFraction - islFraction, 2) * 10;

              // Reward placing an island boundary right after punctuation when there is an acoustic pause
              if (k < K && pauseAfterIslandMs >= 80) {
                const boundaryProfile = profiles[n - 1];
                if (boundaryProfile.hasPausePunctuation) {
                  cost -= 0.45 * Math.min(2, pauseAfterIslandMs / 250);
                }
              }

              const candidateCost = dp[k - 1][prevN] + cost;
              if (candidateCost < dp[k][n]) {
                dp[k][n] = candidateCost;
                parent[k][n] = prevN;
              }
            }
          }
        }

        // Backtrack to recover word range [wStart, wEnd) for each speech island k
        const islandWordRanges: Array<{ wStart: number; wEnd: number }> = new Array(K);
        let currN = N;
        for (let k = K; k >= 1; k--) {
          const prevN = parent[k][currN];
          islandWordRanges[k - 1] = { wStart: prevN, wEnd: currN };
          currN = prevN;
        }

        // Within each island, determine the exact spoken onset of each word assigned to that island
        const wordOnsetsMs: number[] = new Array(N);
        for (let k = 0; k < K; k++) {
          const isl = islands[k];
          const { wStart, wEnd } = islandWordRanges[k];
          const groupCount = wEnd - wStart;
          if (groupCount <= 0) continue;

          if (groupCount === 1) {
            wordOnsetsMs[wStart] = isl.startMs;
            continue;
          }

          // Multiple words in this speech island: build cumulative acoustic + time curve over [isl.startFrame, isl.endFrame)
          const islFrames = Math.max(1, isl.endFrame - isl.startFrame);
          const cumEnergy: number[] = new Array(islFrames + 1).fill(0);
          for (let f = 0; f < islFrames; f++) {
            const eVal = Math.max(0.005, smoothed[isl.startFrame + f] - floorE);
            cumEnergy[f + 1] = cumEnergy[f] + eVal + dynamicRange * 0.35;
          }
          const totalCumE = cumEnergy[islFrames] || 1;

          let groupTotalUnits = 0;
          const wordUnits: number[] = [];
          for (let wIdx = wStart; wIdx < wEnd; wIdx++) {
            const u =
              profiles[wIdx].spokenWeight +
              (wIdx < wEnd - 1 ? profiles[wIdx].pauseAfterWeight * 0.6 : 0);
            wordUnits.push(u);
            groupTotalUnits += u;
          }

          wordOnsetsMs[wStart] = isl.startMs;
          let accUnits = 0;
          const avgFramesPerWord = islFrames / groupCount;
          const valleySearchRadius = Math.max(1, Math.min(6, Math.round(avgFramesPerWord * 0.32)));

          for (let localIdx = 0; localIdx < groupCount - 1; localIdx++) {
            accUnits += wordUnits[localIdx];
            const targetRatio = accUnits / (groupTotalUnits || 1);
            const targetCumE = targetRatio * totalCumE;

            // Find frame index where cumEnergy reaches targetCumE
            let targetFrameOffset = 1;
            for (let f = 1; f < islFrames; f++) {
              if (cumEnergy[f] >= targetCumE) {
                targetFrameOffset = f;
                break;
              }
            }

            // Snap to local acoustic energy valley (syllable/word trough) within search radius
            const searchLow = Math.max(1, targetFrameOffset - valleySearchRadius);
            const searchHigh = Math.min(islFrames - 1, targetFrameOffset + valleySearchRadius);
            let bestFrameOffset = targetFrameOffset;
            let minValleyScore = Infinity;

            for (let f = searchLow; f <= searchHigh; f++) {
              const distPenalty = Math.abs(f - targetFrameOffset) * dynamicRange * 0.08;
              const valleyScore = smoothed[isl.startFrame + f] + distPenalty;
              if (valleyScore < minValleyScore) {
                minValleyScore = valleyScore;
                bestFrameOffset = f;
              }
            }

            const rawBoundaryMs = isl.startMs + bestFrameOffset * frameMs;
            const prevOnsetMs = wordOnsetsMs[wStart + localIdx];
            wordOnsetsMs[wStart + localIdx + 1] = Math.max(
              prevOnsetMs + 20,
              Math.min(isl.endMs - (groupCount - 1 - localIdx) * 15, Math.round(rawBoundaryMs))
            );
          }
        }

        // Ensure first word starts at cueStartMs (or speech onset if leading silence is short)
        // and each word's highlight holds naturally through any subsequent pause until the next word starts
        const firstOnsetMs =
          wordOnsetsMs[0] - cueStartMs <= 60 ? cueStartMs : wordOnsetsMs[0];
        wordOnsetsMs[0] = firstOnsetMs;

        const aligned: WordLevelCaption[] = [];
        for (let i = 0; i < N; i++) {
          const wStart = Math.max(
            i === 0 ? cueStartMs : aligned[i - 1].endMs,
            Math.min(cueEndMs - (N - i), Math.round(wordOnsetsMs[i]))
          );
          const wEnd =
            i === N - 1
              ? cueEndMs
              : Math.max(
                  wStart + 1,
                  Math.min(cueEndMs - (N - 1 - i), Math.round(wordOnsetsMs[i + 1]))
                );
          aligned.push({
            word: words[i],
            startMs: wStart,
            endMs: wEnd,
          });
        }
        return aligned;
      }
    }
  }

  // Phonetic + prosodic pause-aware alignment fallback when no audio waveform envelope is supplied
  const weights = profiles.map(
    (p, idx) => p.spokenWeight + (idx < profiles.length - 1 ? p.pauseAfterWeight : 0)
  );
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || words.length;

  const aligned: WordLevelCaption[] = [];
  let cumulativeWeight = 0;
  for (let i = 0; i < words.length; i++) {
    const startRatio = cumulativeWeight / totalWeight;
    cumulativeWeight += weights[i];
    const endRatio = cumulativeWeight / totalWeight;

    const wordStartMs =
      i === 0
        ? cueStartMs
        : Math.min(
            cueEndMs - (words.length - i),
            Math.max(aligned[i - 1].endMs, Math.round(cueStartMs + startRatio * cueSpanMs))
          );
    const wordEndMs =
      i === words.length - 1
        ? cueEndMs
        : Math.min(
            cueEndMs - (words.length - 1 - i),
            Math.max(wordStartMs + 1, Math.round(cueStartMs + endRatio * cueSpanMs))
          );

    aligned.push({
      word: words[i],
      startMs: wordStartMs,
      endMs: wordEndMs,
    });
  }

  return aligned;
}

/**
 * Generates word-level timing strictly bounded within each clip-relative transcript cue's
 * own [startMs, endMs] window, preserving original words verbatim and never replacing
 * transcript text with Gemini titles.
 * When `options.audioEnvelope` or `options.prosodicTiming` is supplied, uses acoustic
 * forced alignment and phonetic/prosodic pause-aware timing.
 */
export function deriveWordCaptionsFromClipSubtitles(
  clipSubtitles: TranscriptCue[],
  options?: {
    audioEnvelope?: AudioEnergyEnvelope;
    prosodicTiming?: boolean;
  }
): WordLevelCaption[] {
  if (!Array.isArray(clipSubtitles) || clipSubtitles.length === 0) {
    return [];
  }

  const usePrecisionAlignment = Boolean(options?.audioEnvelope || options?.prosodicTiming);

  const alignedWords: WordLevelCaption[] = [];
  for (const cue of clipSubtitles) {
    if (usePrecisionAlignment) {
      const cueAligned = alignCueWordsWithAudioAndProsody(cue, options?.audioEnvelope);
      alignedWords.push(...cueAligned);
      continue;
    }

    const words = cue.text
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words.length === 0) continue;

    const cueSpanMs = Math.max(1, cue.endMs - cue.startMs);
    const stepMs = cueSpanMs / words.length;

    for (let i = 0; i < words.length; i++) {
      const wordStartMs = Math.min(
        cue.endMs - 1,
        Math.max(cue.startMs, Math.round(cue.startMs + i * stepMs))
      );
      const wordEndMs =
        i === words.length - 1
          ? cue.endMs
          : Math.min(cue.endMs, Math.max(wordStartMs + 1, Math.round(cue.startMs + (i + 1) * stepMs)));

      alignedWords.push({
        word: words[i],
        startMs: wordStartMs,
        endMs: wordEndMs,
      });
    }
  }

  return alignedWords;
}

/**
 * Formats milliseconds into ASS timestamp format H:MM:SS.CC (centiseconds).
 */
export function formatAssTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const cs = Math.floor((clamped % 1000) / 10);
  const totalSec = Math.floor(clamped / 1000);
  const s = totalSec % 60;
  const m = Math.floor((totalSec % 3600) / 60);
  const h = Math.floor(totalSec / 3600);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs
    .toString()
    .padStart(2, '0')}`;
}

/**
 * Strips ASS override tags (e.g. {\1c&H28D7FF&}) and converts \N linebreaks back to spaces
 * so plain spoken text can be inspected or compared directly against original transcript cues.
 */
export function stripAssOverrideTags(assText: string): string {
  return assText
    .replace(/\\\{/g, '\u0000')
    .replace(/\\\}/g, '\u0001')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, ' ')
    .replace(/\u0000/g, '{')
    .replace(/\u0001/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Formats a cue's words for a specific active word index with creator-style kinetic highlighting:
 * - Previously spoken words (idx < activeWordIndex): remain visible in a distinct inactive muted silver-slate (&HC4C8CC&).
 * - Currently spoken word (idx === activeWordIndex): highlighted in vibrant high-contrast gold (&H28D7FF&) with 108% kinetic scale.
 * - Upcoming words (idx > activeWordIndex): remain visible in crisp pure white (&HFFFFFF&).
 * Includes controlled line wrapping (\N) suitable for 9:16 vertical video (720x1280).
 */
export function formatWordHighlightedAssCueText(
  words: string[],
  activeWordIndex: number,
  maxWordsPerLine = 5,
  maxCharsPerLine = 28
): string {
  if (!Array.isArray(words) || words.length === 0) {
    return '';
  }

  const lines: string[][] = [];
  let currentLine: string[] = [];
  let currentLineChars = 0;

  for (let i = 0; i < words.length; i++) {
    const rawWord = words[i];
    const safeWord = rawWord.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
    const wordCharLen = Array.from(rawWord).length;

    let styledWord: string;
    if (i < activeWordIndex) {
      // Previously spoken word: visually distinct inactive appearance
      styledWord = `{\\1c&HC4C8CC&\\3c&H14161F&\\fscx100\\fscy100}${safeWord}{\\rDefault}`;
    } else if (i === activeWordIndex) {
      // Currently spoken word: bold kinetic gold highlight + subtle 108% scale pop
      styledWord = `{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}${safeWord}{\\rDefault}`;
    } else {
      // Upcoming word in the same caption cue: clean readable white
      styledWord = `{\\1c&HFFFFFF&\\3c&H14161F&\\fscx100\\fscy100}${safeWord}{\\rDefault}`;
    }

    const projectedChars = currentLine.length === 0 ? wordCharLen : currentLineChars + 1 + wordCharLen;
    if (
      currentLine.length > 0 &&
      (currentLine.length >= maxWordsPerLine || projectedChars > maxCharsPerLine)
    ) {
      lines.push(currentLine);
      currentLine = [styledWord];
      currentLineChars = wordCharLen;
    } else {
      currentLine.push(styledWord);
      currentLineChars = projectedChars;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.map((lineWords) => lineWords.join(' ')).join('\\N');
}

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle script directly from the
 * clip-relative original transcript cues, preserving exact wording and cue intervals.
 * Defaults to dynamic word-by-word kinetic highlighting while keeping static mode recoverable.
 */
export function generateClipAssSubtitleScript(
  clipSubtitles: TranscriptCue[],
  clipDurationMs: number,
  options?: {
    mode?: 'word_highlight' | 'static';
    audioEnvelope?: AudioEnergyEnvelope;
    prosodicTiming?: boolean;
  }
): string {
  const safeDurationMs = Math.max(0, Math.round(clipDurationMs));
  const mode = options?.mode || 'word_highlight';
  const scriptHeader = `[Script Info]
Title: FluxClip OpenShorts Transcript Subtitles
ScriptType: v4.00+
WrapStyle: 2
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,38,&H00FFFFFF,&H0028D7FF,&H0014161F,&H8C000000,-1,0,0,0,100,100,0.5,0,1,3.8,1.8,2,48,48,148,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  let dialogLines = '';
  for (const cue of clipSubtitles) {
    const startMs = Math.max(0, Math.min(safeDurationMs, cue.startMs));
    const endMs = Math.max(0, Math.min(safeDurationMs, cue.endMs));
    if (endMs <= startMs) continue;

    if (mode === 'static') {
      // Original static sentence rendering (recoverable fallback)
      const sanitizedText = cue.text
        .replace(/\r?\n/g, '\\N')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .trim();
      if (!sanitizedText) continue;

      dialogLines += `Dialogue: 0,${formatAssTimestamp(startMs)},${formatAssTimestamp(
        endMs
      )},Default,,0,0,0,,${sanitizedText}\n`;
      continue;
    }

    // Derive word timings for this cue using acoustic forced alignment / prosody when provided
    const cueWords = deriveWordCaptionsFromClipSubtitles(
      [
        {
          index: cue.index,
          startMs,
          endMs,
          text: cue.text,
        },
      ],
      {
        audioEnvelope: options?.audioEnvelope,
        prosodicTiming: options?.prosodicTiming,
      }
    );

    if (cueWords.length === 0) continue;

    // If there is leading silence before the first spoken word onset inside the cue,
    // display the cue line with the first word ready so the caption never pops late or flickers
    const wordTokens = cueWords.map((w) => w.word);
    for (let i = 0; i < cueWords.length; i++) {
      const rawStartMs = i === 0 ? startMs : cueWords[i].startMs;
      const wStartMs = Math.max(startMs, Math.min(endMs, rawStartMs));
      const wEndMs = Math.max(startMs, Math.min(endMs, cueWords[i].endMs));
      if (wEndMs <= wStartMs) continue;

      const highlightedLine = formatWordHighlightedAssCueText(wordTokens, i);
      if (!highlightedLine) continue;

      dialogLines += `Dialogue: 0,${formatAssTimestamp(wStartMs)},${formatAssTimestamp(
        wEndMs
      )},Default,,0,0,0,,${highlightedLine}\n`;
    }
  }

  return scriptHeader + dialogLines;
}

export interface OpenShortsApiClip {
  index: number;
  clipId?: string;
  title: string;
  engagementReasoning?: string;
  video_title_for_youtube_short?: string;
  video_description_for_tiktok?: string;
  video_description_for_instagram?: string;
  start: number;
  end: number;
  startMs?: number;
  endMs?: number;
  subtitles?: TranscriptCue[];
  wordCaptions?: WordLevelCaption[];
  video_url: string;
  download_url?: string;
  thumbnail_url?: string;
}

export function mapOpenShortsClipsToArtifacts(
  apiClips: OpenShortsApiClip[],
  _fallbackPreviewUrl?: string
): ClipArtifact[] {
  if (!apiClips || apiClips.length === 0) {
    return [];
  }

  return apiClips.map((apiClip, idx) => {
    const displayIndex = idx + 1;
    const startSec =
      typeof apiClip.startMs === 'number' ? apiClip.startMs / 1000 : apiClip.start;
    const endSec = typeof apiClip.endMs === 'number' ? apiClip.endMs / 1000 : apiClip.end;
    const durationSeconds = Math.max(1, Math.round(endSec - startSec));

    // Derive fallback captionLines strictly from the original transcript cues/words, NEVER from apiClip.title
    const firstSubtitleText =
      apiClip.subtitles && apiClip.subtitles.length > 0
        ? apiClip.subtitles[0].text.trim()
        : apiClip.wordCaptions && apiClip.wordCaptions.length > 0
          ? apiClip.wordCaptions.map((w) => w.word).join(' ').trim()
          : '';
    const words = firstSubtitleText.split(/\s+/).filter(Boolean);
    const captionLines: [string, string] =
      words.length > 3
        ? [
            words.slice(0, Math.ceil(words.length / 2)).join(' '),
            words.slice(Math.ceil(words.length / 2)).join(' '),
          ]
        : [firstSubtitleText, ''];

    return {
      id: apiClip.clipId || `clip-${displayIndex}`,
      index: displayIndex,
      label: `Clip ${displayIndex}`,
      title: apiClip.title,
      durationSeconds,
      currentSeconds: 0,
      startMs: apiClip.startMs ?? Math.round(startSec * 1000),
      endMs: apiClip.endMs ?? Math.round(endSec * 1000),
      aspectRatio: '9:16',
      reframingMode: 'vertical reframing',
      captionLines,
      subtitles: apiClip.subtitles,
      engagementReasoning: apiClip.engagementReasoning,
      wordCaptions: apiClip.wordCaptions,
      startTimestamp: formatClockTime(startSec),
      endTimestamp: formatClockTime(endSec),
      // Binds strictly to the backend artifact MP4 delivery endpoint
      videoUrl: apiClip.video_url,
      downloadUrl: apiClip.download_url || apiClip.video_url,
      thumbnailUrl: apiClip.thumbnail_url,
    };
  });
}

const MAX_IN_MEMORY_SNAPSHOT_BYTES = 128 * 1024 * 1024; // 128MB safe RAM materialization threshold

/**
 * Snapshots a picked mobile File into an in-memory ArrayBuffer-backed File at selection time
 * so Android content:// URI permissions cannot expire while the user selects other files.
 */
export async function snapshotFileToMemory(file: File): Promise<File> {
  if (file.size <= 0 || file.size > MAX_IN_MEMORY_SNAPSHOT_BYTES) {
    return file;
  }
  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength !== file.size) {
      return file;
    }
    return new File([buffer], file.name, {
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

/**
 * Reads a byte range [start, end) from a File/Blob into a concrete in-memory ArrayBuffer
 * before transmitting over fetch, avoiding lazy Blob-slice streaming failures on mobile proxies.
 */
export async function readChunkAsArrayBuffer(
  blob: Blob,
  start: number,
  end: number
): Promise<ArrayBuffer> {
  const clampedStart = Math.max(0, Math.min(blob.size, start));
  const clampedEnd = Math.max(clampedStart, Math.min(blob.size, end));
  const expectedLength = clampedEnd - clampedStart;
  const slice = blob.slice(clampedStart, clampedEnd);
  const buffer = await slice.arrayBuffer();
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `Incomplete chunk read (${buffer.byteLength} of ${expectedLength} bytes). Re-select the file and try again.`
    );
  }
  return buffer;
}

export const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 512 * 1024; // 512KB mobile-safe chunk size
export const MIN_FALLBACK_CHUNK_SIZE_BYTES = 128 * 1024; // 128KB fallback chunk size on retry

/**
 * Computes the adaptive chunk size in bytes (512KB default, scaling down to 256KB and 128KB on retry).
 */
export function resolveAdaptiveChunkSizeBytes(
  serverChunkSizeBytes: number | undefined,
  retryAttempt: number = 0
): number {
  const baseSize =
    typeof serverChunkSizeBytes === 'number' && serverChunkSizeBytes > 0
      ? Math.min(serverChunkSizeBytes, DEFAULT_UPLOAD_CHUNK_SIZE_BYTES)
      : DEFAULT_UPLOAD_CHUNK_SIZE_BYTES;

  if (retryAttempt <= 0) {
    return baseSize;
  }
  const scaled = Math.floor(baseSize / Math.pow(2, retryAttempt));
  return Math.max(MIN_FALLBACK_CHUNK_SIZE_BYTES, Math.min(baseSize, scaled));
}

export interface ChunkUploadSessionRecord {
  uploadId: string;
  kind: 'video' | 'audio';
  fileName: string;
  mimeType: string;
  totalSizeBytes: number;
  chunkSizeBytes: number;
  receivedChunks: Map<number, { byteOffset: number; byteLength: number }>;
  receivedBytes: number;
  tempFilePath: string;
  verified: boolean;
  probedDurationMs?: number;
  probedWidth?: number;
  probedHeight?: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface SerializedChunkUploadSession {
  uploadId: string;
  kind: 'video' | 'audio';
  fileName: string;
  mimeType: string;
  totalSizeBytes: number;
  chunkSizeBytes: number;
  receivedChunks: Array<[number, { byteOffset: number; byteLength: number }]>;
  receivedBytes: number;
  tempFilePath: string;
  verified: boolean;
  probedDurationMs?: number;
  probedWidth?: number;
  probedHeight?: number;
  createdAt: number;
  lastActivityAt: number;
}

export function serializeChunkUploadSession(session: ChunkUploadSessionRecord): string {
  const payload: SerializedChunkUploadSession = {
    uploadId: session.uploadId,
    kind: session.kind,
    fileName: session.fileName,
    mimeType: session.mimeType,
    totalSizeBytes: session.totalSizeBytes,
    chunkSizeBytes: session.chunkSizeBytes,
    receivedChunks: Array.from(session.receivedChunks.entries()),
    receivedBytes: session.receivedBytes,
    tempFilePath: session.tempFilePath,
    verified: session.verified,
    probedDurationMs: session.probedDurationMs,
    probedWidth: session.probedWidth,
    probedHeight: session.probedHeight,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  };
  return JSON.stringify(payload);
}

export function deserializeChunkUploadSession(rawJson: string): ChunkUploadSessionRecord | null {
  try {
    const parsed = JSON.parse(rawJson) as Partial<SerializedChunkUploadSession>;
    if (
      !parsed ||
      typeof parsed.uploadId !== 'string' ||
      !parsed.uploadId ||
      typeof parsed.tempFilePath !== 'string' ||
      typeof parsed.totalSizeBytes !== 'number'
    ) {
      return null;
    }
    const receivedChunks = new Map<number, { byteOffset: number; byteLength: number }>();
    if (Array.isArray(parsed.receivedChunks)) {
      for (const entry of parsed.receivedChunks) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'number' &&
          entry[1] &&
          typeof entry[1].byteOffset === 'number' &&
          typeof entry[1].byteLength === 'number'
        ) {
          receivedChunks.set(entry[0], {
            byteOffset: entry[1].byteOffset,
            byteLength: entry[1].byteLength,
          });
        }
      }
    }
    return {
      uploadId: parsed.uploadId,
      kind: parsed.kind === 'audio' ? 'audio' : 'video',
      fileName: String(parsed.fileName || 'upload.bin'),
      mimeType: String(parsed.mimeType || 'application/octet-stream'),
      totalSizeBytes: parsed.totalSizeBytes,
      chunkSizeBytes: Number(parsed.chunkSizeBytes || DEFAULT_UPLOAD_CHUNK_SIZE_BYTES),
      receivedChunks,
      receivedBytes: Number(parsed.receivedBytes || 0),
      tempFilePath: parsed.tempFilePath,
      verified: Boolean(parsed.verified),
      probedDurationMs: parsed.probedDurationMs,
      probedWidth: parsed.probedWidth,
      probedHeight: parsed.probedHeight,
      createdAt: Number(parsed.createdAt || Date.now()),
      lastActivityAt: Number(parsed.lastActivityAt || Date.now()),
    };
  } catch {
    return null;
  }
}

/**
 * Formats an actionable chunk upload error message preserving the underlying HTTP status,
 * server error code, or mobile browser DOMException reason (e.g., NotReadableError).
 */
export function formatChunkUploadFailureMessage(
  fileName: string,
  chunkIndex: number,
  lastFailureReason?: string
): string {
  const cleanReason = (lastFailureReason || '').trim();
  if (!cleanReason) {
    return `Failed to upload chunk ${chunkIndex} of ${fileName} after retries.`;
  }
  return `Failed to upload chunk ${chunkIndex} of ${fileName} after retries (${cleanReason}).`;
}

export const GEMINI_FALLBACK_MODEL_POOL = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemma-4-26b-a4b-it',
] as const;

/**
 * Builds an ordered, deduplicated model failover cascade starting with the user's selected model.
 */
export function buildGeminiModelCascade(preferredModel?: string): string[] {
  const cleanPreferred = (preferredModel || 'gemini-3.8-flash').trim();
  const ordered = [cleanPreferred, ...GEMINI_FALLBACK_MODEL_POOL];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of ordered) {
    if (m && !seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }
  return result;
}

/**
 * Identifies whether a Gemini error is caused by transient upstream high demand (503),
 * rate spikes (429 on specific model), or network/request timeout rather than an invalid API key.
 */
export function isTransientGeminiHighDemandOrTimeoutError(rawMessage: string): boolean {
  const lower = (rawMessage || '').toLowerCase();
  if (
    lower.includes('api_key_invalid') ||
    lower.includes('key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('403')
  ) {
    return false;
  }
  return (
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline') ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('fetch failed')
  );
}

/**
 * Deterministic transcript-driven viral moment analyzer used as a high-availability fallback
 * when all upstream Gemini models experience simultaneous 503 high-demand or timeout spikes.
 */
export function analyzeTranscriptHooksFallback(
  cues: TranscriptCue[],
  sourceDurationMs: number
): GeminiViralMomentHook[] {
  const validCues = cues.filter(
    (c) => c.startMs >= 0 && c.startMs < sourceDurationMs && c.endMs > c.startMs && c.text.trim().length > 0
  );
  if (validCues.length === 0 || sourceDurationMs <= 0) {
    return [];
  }

  // If the entire video is short (<= 65s), return a single clip covering the active transcript span
  if (sourceDurationMs <= 65000) {
    const startMs = Math.max(0, validCues[0].startMs);
    const endMs = Math.min(
      sourceDurationMs,
      Math.max(startMs + 5000, validCues[validCues.length - 1].endMs)
    );
    const firstWords = validCues[0].text
      .replace(/[^\w\s'-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join(' ');
    return [
      {
        clipId: 'clip-1',
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        title: firstWords || 'Featured Highlight',
        engagementReasoning: 'High-density spoken segment from uploaded transcript.',
      },
    ];
  }

  // Score candidate windows of 25s..50s across the transcript
  const targetWindowMs = Math.min(45000, Math.max(15000, Math.floor(sourceDurationMs / 3)));
  interface CandidateWindow {
    startMs: number;
    endMs: number;
    score: number;
    leadText: string;
  }

  const candidates: CandidateWindow[] = [];
  for (let i = 0; i < validCues.length; i++) {
    const startCue = validCues[i];
    const startMs = startCue.startMs;
    if (startMs + 8000 > sourceDurationMs) break;

    let endMs = Math.min(sourceDurationMs, startCue.endMs);
    let score = 0;
    let cueCount = 0;

    for (let j = i; j < validCues.length; j++) {
      const cue = validCues[j];
      const clampedCueEnd = Math.min(sourceDurationMs, cue.endMs);
      if (clampedCueEnd - startMs > 60000 && cueCount > 0) break;

      endMs = clampedCueEnd;
      cueCount++;
      const t = cue.text;
      const wordCount = t.split(/\s+/).filter(Boolean).length;
      score += wordCount * 1.5;
      if (t.includes('?')) score += 12;
      if (t.includes('!')) score += 10;
      if (/\b(why|how|never|secret|crazy|funny|wild|listen|wait|actually|story|truth)\b/i.test(t)) {
        score += 8;
      }

      if (endMs - startMs >= targetWindowMs) {
        break;
      }
    }

    const duration = endMs - startMs;
    if (duration >= 8000 && duration <= 90000) {
      candidates.push({
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        score,
        leadText: startCue.text,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected: GeminiViralMomentHook[] = [];
  for (const cand of candidates) {
    const overlaps = selected.some((s) => {
      const overlapStart = Math.max(s.startMs, cand.startMs);
      const overlapEnd = Math.min(s.endMs, cand.endMs);
      return Math.max(0, overlapEnd - overlapStart) > 5000;
    });
    if (overlaps) continue;

    const cleanWords = cand.leadText
      .replace(/[^\w\s'-]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join(' ');

    selected.push({
      clipId: `clip-${selected.length + 1}`,
      startMs: cand.startMs,
      endMs: cand.endMs,
      title: cleanWords ? `${cleanWords}...` : `Highlight Clip ${selected.length + 1}`,
      engagementReasoning: 'Selected for high dialogue pacing and narrative hook density.',
    });

    if (selected.length >= 3) break;
  }

  // Sort chronologically by startMs
  selected.sort((a, b) => a.startMs - b.startMs);
  return selected.map((h, idx) => ({
    ...h,
    clipId: `clip-${idx + 1}`,
  }));
}

/**
 * Resolves the authoritative attachment download URL and gallery-ready MP4 filename for a clip.
 * Always prioritizes downloadUrl over videoUrl and enforces download=1 so the backend serves
 * Content-Disposition: attachment for mobile DownloadManager / Gallery indexing.
 */
export function buildClipDownloadUrl(
  clip: Pick<ClipArtifact, 'id' | 'videoUrl' | 'downloadUrl'> | null | undefined,
  exportQuality: string = '1080p'
): { downloadUrl: string; fileName: string } | null {
  if (!clip) return null;
  const rawBaseUrl = (clip.downloadUrl || clip.videoUrl || '').trim();
  if (!rawBaseUrl) return null;

  const safeId = (clip.id || 'clip-1').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeQuality = (exportQuality || '1080p').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `fluxclip_${safeId}_${safeQuality}_9x16.mp4`;

  let downloadUrl = rawBaseUrl;
  if (!/[?&]download=1\b/.test(downloadUrl)) {
    downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + 'download=1';
  }
  if (!/[?&]filename=/.test(downloadUrl)) {
    downloadUrl += `&filename=${encodeURIComponent(fileName)}`;
  }

  return { downloadUrl, fileName };
}







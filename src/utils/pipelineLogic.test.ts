import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSourceInput,
  classifyRemoteVideoUrl,
  buildUnifiedMediaSource,
  parseTimecodeToMs,
  parseTimecodedTranscript,
  validateMandatoryPipelinePayloads,
  formatClockTime,
  formatSegmentTitle,
  formatSegmentDurationLabel,
  mapOpenShortsClipsToArtifacts,
  buildAdaptive9x16VideoFilter,
  clampHookToMediaDuration,
  isHtmlOrWebpageContentType,
  classifyYouTubeExtractionFailure,
  extractClipRelativeSubtitles,
  deriveWordCaptionsFromClipSubtitles,
  generateClipAssSubtitleScript,
  formatWordHighlightedAssCueText,
  stripAssOverrideTags,
  extractPcmS16LeRmsEnvelope,
  computeWordAcousticProsodicProfile,
  alignCueWordsWithAudioAndProsody,
  readChunkAsArrayBuffer,
  snapshotFileToMemory,
  DEFAULT_UPLOAD_CHUNK_SIZE_BYTES,
  MIN_FALLBACK_CHUNK_SIZE_BYTES,
  resolveAdaptiveChunkSizeBytes,
  serializeChunkUploadSession,
  deserializeChunkUploadSession,
  formatChunkUploadFailureMessage,
  buildGeminiModelCascade,
  isTransientGeminiHighDemandOrTimeoutError,
  analyzeTranscriptHooksFallback,
  buildClipDownloadUrl,
} from './pipelineLogic';

const TEST_SRT = `1
00:02:14,000 --> 00:02:58,000
Opening segment with timecoded transcript.

2
00:08:40,000 --> 00:09:32,000
Second segment for validation testing.`;

test('validateSourceInput rejects empty URL and null file', () => {
  const result = validateSourceInput('   ', null);
  assert.equal(result.valid, false);
  assert.equal(result.sourceType, null);
  assert.equal(result.errorCode, 'MISSING_VIDEO_SOURCE');
});

test('classifyRemoteVideoUrl distinguishes YouTube URLs from Direct Video URLs', () => {
  const yt = classifyRemoteVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(yt.valid, true);
  assert.equal(yt.inputMode, 'youtube_url');

  const directMp4 = classifyRemoteVideoUrl('https://cdn.example.com/studio/podcast_raw.mp4');
  assert.equal(directMp4.valid, true);
  assert.equal(directMp4.inputMode, 'direct_url');
  assert.equal(directMp4.containerFormat, 'mp4');
});

test('buildUnifiedMediaSource normalizes all 3 input modes without synthetic yt-dlp schemes', () => {
  const direct = buildUnifiedMediaSource({
    inputMode: 'direct_url',
    sourceUri: 'https://cdn.example.com/master.webm',
    durationMs: 600000,
    supportsByteRange: true,
  });
  assert.equal(direct.extractionStrategy, 'http_range_stream');
  assert.equal(direct.containerFormat, 'webm');

  const yt = buildUnifiedMediaSource({
    inputMode: 'youtube_url',
    sourceUri: 'https://youtu.be/abc123',
    durationMs: 600000,
  });
  assert.equal(yt.extractionStrategy, 'yt_dlp_targeted_stream');
  assert.equal(yt.supportsByteRange, true);
  assert.equal(yt.resolvedStreamUri, 'https://youtu.be/abc123');

  const local = buildUnifiedMediaSource({
    inputMode: 'local_upload',
    sourceUri: '/tmp/staging/upload_1.mov',
    durationMs: 600000,
  });
  assert.equal(local.extractionStrategy, 'chunked_local_staging');
  assert.equal(local.containerFormat, 'mov');
});

test('buildAdaptive9x16VideoFilter produces correct crop and scale expressions for different aspect ratios', () => {
  // Landscape 16:9 (1920x1080) -> crop width to 9:16 center, scale to 720:1280
  const landscape = buildAdaptive9x16VideoFilter({ sourceWidth: 1920, sourceHeight: 1080 });
  assert.ok(landscape.includes('crop='));
  assert.ok(landscape.includes('scale=720:1280'));

  // Already 9:16 (1080x1920) -> scale directly without cropping
  const vertical = buildAdaptive9x16VideoFilter({ sourceWidth: 1080, sourceHeight: 1920 });
  assert.equal(vertical, 'scale=720:1280,setsar=1');

  // Narrower than 9:16 (e.g. 500x1200) -> crop height to 9:16
  const narrow = buildAdaptive9x16VideoFilter({ sourceWidth: 500, sourceHeight: 1200 });
  assert.ok(narrow.includes('crop='));
  assert.ok(narrow.includes('scale=720:1280'));
});

test('parseTimecodedTranscript parses SRT and TXT timecodes with millisecond precision', () => {
  assert.equal(parseTimecodeToMs('00:02:14,000'), 134000);
  assert.equal(parseTimecodeToMs('00:14:05.250'), 845250);

  const srtResult = parseTimecodedTranscript(TEST_SRT);
  assert.equal(srtResult.valid, true);
  assert.equal(srtResult.cues.length, 2);
  assert.equal(srtResult.cues[0].startMs, 134000);
  assert.equal(srtResult.cues[0].endMs, 178000);

  const txtResult = parseTimecodedTranscript(
    '[00:01:00.000 - 00:01:35.500] Opening hook on creator retention\n[00:02:10.000 - 00:02:45.000] Second segment'
  );
  assert.equal(txtResult.valid, true);
  assert.equal(txtResult.cues.length, 2);
  assert.equal(txtResult.cues[0].endMs, 95500);
});

test('validateMandatoryPipelinePayloads enforces transcript timecodes and master audio duration sync', () => {
  const validCheck = validateMandatoryPipelinePayloads({
    videoDurationMs: 600000,
    masterAudio: {
      fileName: 'master_audio.mp3',
      format: 'mp3',
      sizeBytes: 24 * 1024 * 1024,
      durationMs: 600500,
    },
    transcriptText: TEST_SRT,
  });
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.cues.length, 2);

  const mismatchCheck = validateMandatoryPipelinePayloads({
    videoDurationMs: 1800000,
    masterAudio: {
      fileName: 'desynced_audio.wav',
      format: 'wav',
      sizeBytes: 10 * 1024 * 1024,
      durationMs: 900000,
    },
    transcriptText: TEST_SRT,
  });
  assert.equal(mismatchCheck.valid, false);
  assert.equal(mismatchCheck.errorCode, 'AUDIO_VIDEO_DURATION_MISMATCH');
});

test('validateMandatoryPipelinePayloads allows up to 5000ms trailing caption hold ONLY on the final cue without modifying transcript', () => {
  const realCaseSrt = `250
00:14:20,000 --> 00:14:25,500
Penultimate spoken line before outro.

251
00:14:26,100 --> 00:14:30,240
Final spoken line with 1.488s trailing caption hold.`;

  const res = validateMandatoryPipelinePayloads({
    videoDurationMs: 868752, // 00:14:28.752
    masterAudio: {
      fileName: 'master.mp3',
      format: 'mp3',
      sizeBytes: 17428306,
      durationMs: 868704, // 00:14:28.704 (48ms drift)
    },
    transcriptText: realCaseSrt,
  });

  assert.equal(res.valid, true);
  assert.equal(res.cues.length, 2);
  // Original uploaded transcript cue timestamps must remain unmodified
  assert.equal(res.cues[1].startMs, 866100);
  assert.equal(res.cues[1].endMs, 870240);

  // Non-final cue exceeding media duration by > 1000ms (even if within 5000ms) must be rejected
  const nonFinalExceedingSrt = `1
00:14:25,000 --> 00:14:30,240
Non-final cue exceeding by 1.488s.

2
00:14:26,000 --> 00:14:28,000
Final cue within bounds.`;

  const nonFinalRes = validateMandatoryPipelinePayloads({
    videoDurationMs: 868752,
    masterAudio: {
      fileName: 'master.mp3',
      format: 'mp3',
      sizeBytes: 17428306,
      durationMs: 868704,
    },
    transcriptText: nonFinalExceedingSrt,
  });
  assert.equal(nonFinalRes.valid, false);
  assert.equal(nonFinalRes.errorCode, 'TRANSCRIPT_OUT_OF_BOUNDS');
});

test('validateMandatoryPipelinePayloads rejects cues starting at or after video ends and genuinely mismatched transcripts', () => {
  // Cue starts after video ends (00:14:28.800 >= 00:14:28.752), even though endMs is within +5000ms
  const lateStartSrt = `1
00:02:00,000 --> 00:02:10,000
Valid intro cue.

2
00:14:28,800 --> 00:14:30,240
Cue starting after actual video ended.`;

  const lateStartRes = validateMandatoryPipelinePayloads({
    videoDurationMs: 868752,
    masterAudio: {
      fileName: 'master.mp3',
      format: 'mp3',
      sizeBytes: 17428306,
      durationMs: 868704,
    },
    transcriptText: lateStartSrt,
  });
  assert.equal(lateStartRes.valid, false);
  assert.equal(lateStartRes.errorCode, 'TRANSCRIPT_OUT_OF_BOUNDS');
  assert.ok(lateStartRes.errorMessage?.includes('starts at'));

  // Genuinely mismatched transcript where final cue exceeds +5000ms trailing tolerance
  const mismatchedTranscriptSrt = `1
00:02:00,000 --> 00:02:15,000
Intro cue.

2
00:14:25,000 --> 00:14:35,000
Cue ending 6.248s after media ends.`;

  const mismatchedRes = validateMandatoryPipelinePayloads({
    videoDurationMs: 868752,
    masterAudio: {
      fileName: 'master.mp3',
      format: 'mp3',
      sizeBytes: 17428306,
      durationMs: 868704,
    },
    transcriptText: mismatchedTranscriptSrt,
  });
  assert.equal(mismatchedRes.valid, false);
  assert.equal(mismatchedRes.errorCode, 'TRANSCRIPT_OUT_OF_BOUNDS');
  assert.ok(mismatchedRes.errorMessage?.includes('exceeding media duration'));
});

test('clampHookToMediaDuration and YouTube stream helpers enforce safe media boundaries', () => {
  const clamped = clampHookToMediaDuration(
    {
      clipId: 'clip-1',
      startMs: 840000,
      endMs: 870240,
      title: 'Outro Hook',
      engagementReasoning: 'Strong closing thought',
    },
    868752
  );
  assert.ok(clamped !== null);
  assert.equal(clamped?.startMs, 840000);
  assert.equal(clamped?.endMs, 868752);

  const invalidHook = clampHookToMediaDuration(
    {
      clipId: 'clip-2',
      startMs: 869000,
      endMs: 870240,
      title: 'Past End',
      engagementReasoning: 'Starts after video ends',
    },
    868752
  );
  assert.equal(invalidHook, null);

  assert.equal(isHtmlOrWebpageContentType('text/html; charset=utf-8'), true);
  assert.equal(isHtmlOrWebpageContentType('video/mp4'), false);

  const botBlocked = classifyYouTubeExtractionFailure(
    "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot."
  );
  assert.equal(botBlocked.errorCode, 'YOUTUBE_EXTRACTION_BLOCKED');
  assert.ok(botBlocked.userMessage.includes('local MP4/MOV'));
});

test('extractClipRelativeSubtitles and generateClipAssSubtitleScript preserve exact original transcript cues and clip-relative timing without Gemini taglines', () => {
  const sourceCues = [
    { index: 1, startMs: 120000, endMs: 125000, text: 'Outside earlier cue before clip.' },
    { index: 2, startMs: 178000, endMs: 182000, text: 'Crossing start boundary spoken line.' },
    { index: 3, startMs: 185000, endMs: 189500, text: 'Spoken five seconds after clip starts.' },
    { index: 4, startMs: 208000, endMs: 213000, text: 'Crossing end boundary spoken line.' },
    { index: 5, startMs: 220000, endMs: 225000, text: 'Outside later cue after clip.' },
  ];

  // Clip starts at 00:03:00 (180000ms) and ends at 00:03:30 (210000ms) -> 30000ms duration
  const clipSubtitles = extractClipRelativeSubtitles(sourceCues, 180000, 210000);
  assert.equal(clipSubtitles.length, 3);

  // Cue #2 (178s -> 182s) clamped to [0ms, 2000ms], text preserved verbatim
  assert.equal(clipSubtitles[0].startMs, 0);
  assert.equal(clipSubtitles[0].endMs, 2000);
  assert.equal(clipSubtitles[0].text, 'Crossing start boundary spoken line.');

  // Cue #3 (00:03:05 -> 00:03:09.500) appears at 00:00:05 (5000ms -> 9500ms), NOT restarted at 00:00
  assert.equal(clipSubtitles[1].startMs, 5000);
  assert.equal(clipSubtitles[1].endMs, 9500);
  assert.equal(clipSubtitles[1].text, 'Spoken five seconds after clip starts.');

  // Cue #4 (208s -> 213s) clamped to [28000ms, 30000ms], text preserved verbatim
  assert.equal(clipSubtitles[2].startMs, 28000);
  assert.equal(clipSubtitles[2].endMs, 30000);
  assert.equal(clipSubtitles[2].text, 'Crossing end boundary spoken line.');

  const wordCaps = deriveWordCaptionsFromClipSubtitles(clipSubtitles);
  assert.ok(wordCaps.length > 0);
  // Words from Cue #3 must start >= 5000ms and end <= 9500ms
  const fiveSecWord = wordCaps.find((w) => w.word === 'Spoken');
  assert.ok(fiveSecWord);
  assert.equal(fiveSecWord?.startMs, 5000);

  // Recoverable static mode preserves single-line Dialogue events
  const staticAssScript = generateClipAssSubtitleScript(clipSubtitles, 30000, { mode: 'static' });
  assert.ok(staticAssScript.includes('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Crossing start boundary spoken line.'));
  assert.ok(staticAssScript.includes('Dialogue: 0,0:00:05.00,0:00:09.50,Default,,0,0,0,,Spoken five seconds after clip starts.'));
  assert.ok(staticAssScript.includes('Dialogue: 0,0:00:28.00,0:00:30.00,Default,,0,0,0,,Crossing end boundary spoken line.'));

  // Default word-by-word highlighted mode preserves exact words and clip-relative word windows
  const assScript = generateClipAssSubtitleScript(clipSubtitles, 30000);
  const dialogueLines = assScript
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogueLines.length, wordCaps.length);
  assert.equal(
    stripAssOverrideTags(dialogueLines[0].split(',,').slice(-1)[0]),
    'Crossing start boundary spoken line.'
  );
  assert.ok(assScript.includes('Dialogue: 0,0:00:05.00,0:00:05.75,Default,,0,0,0,,{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}Spoken{\\rDefault}'));
  assert.equal(assScript.includes('Outside earlier cue'), false);
  assert.equal(assScript.includes('Outside later cue'), false);
});

test('mapOpenShortsClipsToArtifacts binds distinct backend artifact MP4 URLs and keeps Gemini title separate from captionLines', () => {
  assert.deepEqual(mapOpenShortsClipsToArtifacts([]), []);

  const mapped = mapOpenShortsClipsToArtifacts([
    {
      index: 0,
      clipId: 'hook-1',
      title: 'Police vs Stoner: The Funny Encounter',
      start: 180,
      end: 210,
      startMs: 180000,
      endMs: 210000,
      subtitles: [
        {
          index: 3,
          startMs: 5000,
          endMs: 9500,
          text: 'Original spoken transcript words inside clip one',
        },
      ],
      engagementReasoning: 'Strong opening statement.',
      video_url: '/api/artifacts/job1/clip-1.mp4',
      download_url: '/api/artifacts/job1/clip-1.mp4?download=1',
    },
    {
      index: 1,
      clipId: 'hook-2',
      title: 'The Stench of Delusion',
      start: 520,
      end: 572,
      startMs: 520000,
      endMs: 572000,
      subtitles: [
        {
          index: 12,
          startMs: 1200,
          endMs: 6400,
          text: 'Actual spoken dialogue from clip two',
        },
      ],
      engagementReasoning: 'Follow-up discussion.',
      video_url: '/api/artifacts/job1/clip-2.mp4',
      download_url: '/api/artifacts/job1/clip-2.mp4?download=1',
    },
  ]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].videoUrl, '/api/artifacts/job1/clip-1.mp4');
  assert.equal(mapped[1].videoUrl, '/api/artifacts/job1/clip-2.mp4');
  assert.equal(mapped[0].title, 'Police vs Stoner: The Funny Encounter');
  assert.equal(mapped[1].title, 'The Stench of Delusion');
  // captionLines must never contain the Gemini title
  assert.equal(mapped[0].captionLines.join(' ').includes('Police vs Stoner'), false);
  assert.equal(mapped[1].captionLines.join(' ').includes('Stench of Delusion'), false);
  assert.equal(mapped[0].captionLines.join(' '), 'Original spoken transcript words inside clip one');
  assert.equal(mapped[0].durationSeconds, 30);
  assert.equal(formatClockTime(mapped[0].durationSeconds), '0:30');
  assert.equal(formatSegmentTitle(mapped[0]), 'Clip 1 • 9:16 vertical reframing');
  assert.equal(formatSegmentDurationLabel(mapped[0]), '30 seconds');
});

test('Fix 1: snapshotFileToMemory and readChunkAsArrayBuffer materialize in-memory ArrayBuffers accurately', async () => {
  const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const originalFile = new File([payload], '404479.mp4', {
    type: 'video/mp4',
    lastModified: 1700000000000,
  });

  const snapshotted = await snapshotFileToMemory(originalFile);
  assert.equal(snapshotted.name, '404479.mp4');
  assert.equal(snapshotted.size, 8);
  assert.equal(snapshotted.type, 'video/mp4');

  const chunk0 = await readChunkAsArrayBuffer(snapshotted, 0, 4);
  assert.equal(chunk0.byteLength, 4);
  assert.deepEqual(Array.from(new Uint8Array(chunk0)), [10, 20, 30, 40]);

  const chunk1 = await readChunkAsArrayBuffer(snapshotted, 4, 10);
  assert.equal(chunk1.byteLength, 4);
  assert.deepEqual(Array.from(new Uint8Array(chunk1)), [50, 60, 70, 80]);
});

test('Fix 2: resolveAdaptiveChunkSizeBytes defaults to 512KB and falls back to 256KB and 128KB on retries', () => {
  assert.equal(DEFAULT_UPLOAD_CHUNK_SIZE_BYTES, 512 * 1024);
  assert.equal(MIN_FALLBACK_CHUNK_SIZE_BYTES, 128 * 1024);

  // Even if server advertises 8MB, client caps initial chunk size at 512KB
  assert.equal(resolveAdaptiveChunkSizeBytes(8 * 1024 * 1024, 0), 512 * 1024);
  assert.equal(resolveAdaptiveChunkSizeBytes(512 * 1024, 0), 512 * 1024);

  // Retry 1 halves to 256KB
  assert.equal(resolveAdaptiveChunkSizeBytes(512 * 1024, 1), 256 * 1024);

  // Retry 2 halves to 128KB (minimum fallback floor)
  assert.equal(resolveAdaptiveChunkSizeBytes(512 * 1024, 2), 128 * 1024);
  assert.equal(resolveAdaptiveChunkSizeBytes(512 * 1024, 3), 128 * 1024);
});

test('Fix 3: serializeChunkUploadSession and deserializeChunkUploadSession preserve upload session state across restarts', () => {
  const chunks = new Map<number, { byteOffset: number; byteLength: number }>();
  chunks.set(0, { byteOffset: 0, byteLength: 524288 });
  chunks.set(1, { byteOffset: 524288, byteLength: 200000 });

  const rawJson = serializeChunkUploadSession({
    uploadId: 'upl_test_123',
    kind: 'video',
    fileName: '404479.mp4',
    mimeType: 'video/mp4',
    totalSizeBytes: 724288,
    chunkSizeBytes: 524288,
    receivedChunks: chunks,
    receivedBytes: 724288,
    tempFilePath: '/tmp/fluxclip-openshorts-staging/uploads/upl_test_123_404479.mp4',
    verified: true,
    probedDurationMs: 868752,
    probedWidth: 1920,
    probedHeight: 1080,
    createdAt: 1700000000000,
    lastActivityAt: 1700000005000,
  });

  const restored = deserializeChunkUploadSession(rawJson);
  assert.ok(restored !== null);
  assert.equal(restored?.uploadId, 'upl_test_123');
  assert.equal(restored?.fileName, '404479.mp4');
  assert.equal(restored?.receivedBytes, 724288);
  assert.equal(restored?.receivedChunks.size, 2);
  assert.deepEqual(restored?.receivedChunks.get(1), { byteOffset: 524288, byteLength: 200000 });
  assert.equal(restored?.probedDurationMs, 868752);
});

test('Fix 4: formatChunkUploadFailureMessage surfaces exact HTTP error codes and browser DOMException reasons', () => {
  assert.equal(
    formatChunkUploadFailureMessage('404479.mp4', 0, 'NotReadableError: The requested file could not be read.'),
    'Failed to upload chunk 0 of 404479.mp4 after retries (NotReadableError: The requested file could not be read.).'
  );
  assert.equal(
    formatChunkUploadFailureMessage(
      '404479.mp4',
      0,
      'HTTP 404 UPLOAD_SESSION_NOT_FOUND: Chunk upload session expired or does not exist.'
    ),
    'Failed to upload chunk 0 of 404479.mp4 after retries (HTTP 404 UPLOAD_SESSION_NOT_FOUND: Chunk upload session expired or does not exist.).'
  );
  assert.equal(
    formatChunkUploadFailureMessage('404479.mp4', 2, ''),
    'Failed to upload chunk 2 of 404479.mp4 after retries.'
  );
});

test('Gemini pipeline resilience: buildGeminiModelCascade, isTransientGeminiHighDemandOrTimeoutError, and analyzeTranscriptHooksFallback handle 503 high demand and timeouts', () => {
  const cascade = buildGeminiModelCascade('gemini-3.1-flash-lite');
  assert.equal(cascade[0], 'gemini-3.1-flash-lite');
  assert.ok(cascade.includes('gemini-3.6-flash'));
  assert.ok(cascade.includes('gemini-3.5-flash'));
  assert.ok(cascade.includes('gemini-3.8-flash'));
  assert.ok(cascade.includes('gemma-4-26b-a4b-it'));
  assert.equal(new Set(cascade).size, cascade.length);

  assert.equal(
    isTransientGeminiHighDemandOrTimeoutError(
      '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
    ),
    true
  );
  assert.equal(
    isTransientGeminiHighDemandOrTimeoutError('CONNECTION_TIMEOUT: Request timed out after 10s'),
    true
  );
  assert.equal(
    isTransientGeminiHighDemandOrTimeoutError('API_KEY_INVALID: API key not valid.'),
    false
  );

  const sampleCues = [
    { index: 1, startMs: 5000, endMs: 18000, text: 'Wait until you hear this crazy story about the police encounter!' },
    { index: 2, startMs: 18000, endMs: 32000, text: 'Why did the officer look straight through the window like that?' },
    { index: 3, startMs: 90000, endMs: 115000, text: 'Here is the secret truth nobody talks about in podcasting.' },
  ];
  const fallbackHooks = analyzeTranscriptHooksFallback(sampleCues, 120000);
  assert.ok(fallbackHooks.length >= 1);
  for (const h of fallbackHooks) {
    assert.ok(h.startMs >= 0);
    assert.ok(h.endMs <= 120000);
    assert.ok(h.endMs > h.startMs);
    assert.ok(h.title.length > 0);
  }
});

test('buildClipDownloadUrl prioritizes downloadUrl over videoUrl, enforces download=1, and builds Gallery-ready MP4 filename', () => {
  const res = buildClipDownloadUrl(
    {
      id: 'clip-1',
      videoUrl: '/api/artifacts/job-123/clip-1.mp4?t=1700000000',
      downloadUrl: '/api/artifacts/job-123/clip-1.mp4?t=1700000000&download=1',
    },
    '1080p'
  );
  assert.ok(res !== null);
  assert.equal(res.downloadUrl, '/api/artifacts/job-123/clip-1.mp4?t=1700000000&download=1&filename=fluxclip_clip-1_1080p_9x16.mp4');
  assert.equal(res.fileName, 'fluxclip_clip-1_1080p_9x16.mp4');

  // Even if downloadUrl is missing and only videoUrl is present, download=1 is appended
  const fallbackRes = buildClipDownloadUrl(
    {
      id: 'clip-2',
      videoUrl: '/api/artifacts/job-123/clip-2.mp4?t=1700000000',
    },
    '720p'
  );
  assert.ok(fallbackRes !== null);
  assert.equal(fallbackRes.downloadUrl, '/api/artifacts/job-123/clip-2.mp4?t=1700000000&download=1&filename=fluxclip_clip-2_720p_9x16.mp4');
  assert.equal(fallbackRes.fileName, 'fluxclip_clip-2_720p_9x16.mp4');
});

test('Safe Word-by-Word Highlighted Captions Upgrade: verifies English & Hindi word progression, active/inactive states, and exact timestamp synchronization across multiple clips', () => {
  // 1. Verify exact progression on "I NEVER SAID THAT." (from 00:00:02.000 to 00:00:04.000 -> 500ms per word)
  const enCue = [{ index: 1, startMs: 2000, endMs: 4000, text: 'I NEVER SAID THAT.' }];
  const enAss = generateClipAssSubtitleScript(enCue, 10000);
  const enDialogues = enAss.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(enDialogues.length, 4);

  // Step 1 (2.00s -> 2.50s): "I" is highlighted (&H28D7FF&), "NEVER SAID THAT." are upcoming (&HFFFFFF&)
  assert.ok(enDialogues[0].startsWith('Dialogue: 0,0:00:02.00,0:00:02.50,Default,,0,0,0,,'));
  assert.ok(enDialogues[0].includes('{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}I{\\rDefault}'));
  assert.ok(enDialogues[0].includes('{\\1c&HFFFFFF&\\3c&H14161F&\\fscx100\\fscy100}NEVER{\\rDefault}'));
  assert.equal(stripAssOverrideTags(enDialogues[0].split(',,').slice(-1)[0]), 'I NEVER SAID THAT.');

  // Step 2 (2.50s -> 3.00s): "I" is spoken/inactive (&HC4C8CC&), "NEVER" is highlighted (&H28D7FF&)
  assert.ok(enDialogues[1].startsWith('Dialogue: 0,0:00:02.50,0:00:03.00,Default,,0,0,0,,'));
  assert.ok(enDialogues[1].includes('{\\1c&HC4C8CC&\\3c&H14161F&\\fscx100\\fscy100}I{\\rDefault}'));
  assert.ok(enDialogues[1].includes('{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}NEVER{\\rDefault}'));

  // Step 3 (3.00s -> 3.50s): "I" and "NEVER" are inactive, "SAID" is highlighted
  assert.ok(enDialogues[2].startsWith('Dialogue: 0,0:00:03.00,0:00:03.50,Default,,0,0,0,,'));
  assert.ok(enDialogues[2].includes('{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}SAID{\\rDefault}'));

  // Step 4 (3.50s -> 4.00s): "I", "NEVER", "SAID" are inactive, "THAT." is highlighted
  assert.ok(enDialogues[3].startsWith('Dialogue: 0,0:00:03.50,0:00:04.00,Default,,0,0,0,,'));
  assert.ok(enDialogues[3].includes('{\\1c&H28D7FF&\\3c&H0D0F17&\\fscx108\\fscy108}THAT.{\\rDefault}'));
  assert.equal(stripAssOverrideTags(enDialogues[3].split(',,').slice(-1)[0]), 'I NEVER SAID THAT.');

  // 2. Verify Hindi (Devanagari) and mixed Hindi-English cues across 2 distinct clips
  const fullTranscript = [
    { index: 1, startMs: 10000, endMs: 13000, text: 'भाई मैंने ऐसा कभी नहीं कहा' },
    { index: 2, startMs: 65000, endMs: 68000, text: 'Wait सुनो मेरी बात ध्यान से' },
  ];

  const clip1Cues = extractClipRelativeSubtitles(fullTranscript, 8000, 18000);
  const clip2Cues = extractClipRelativeSubtitles(fullTranscript, 60000, 70000);

  assert.equal(clip1Cues.length, 1);
  assert.equal(clip1Cues[0].startMs, 2000);
  assert.equal(clip1Cues[0].endMs, 5000);

  assert.equal(clip2Cues.length, 1);
  assert.equal(clip2Cues[0].startMs, 5000);
  assert.equal(clip2Cues[0].endMs, 8000);

  const clip1Ass = generateClipAssSubtitleScript(clip1Cues, 10000);
  const clip2Ass = generateClipAssSubtitleScript(clip2Cues, 10000);

  const clip1Lines = clip1Ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  const clip2Lines = clip2Ass.split('\n').filter((l) => l.startsWith('Dialogue:'));

  // 6 Hindi words in Clip 1 -> 6 word-level Dialogue events spanning 0:00:02.00 to 0:00:05.00
  assert.equal(clip1Lines.length, 6);
  assert.ok(clip1Lines[0].startsWith('Dialogue: 0,0:00:02.00,0:00:02.50,'));
  assert.ok(clip1Lines[5].startsWith('Dialogue: 0,0:00:04.50,0:00:05.00,'));
  for (const line of clip1Lines) {
    assert.equal(stripAssOverrideTags(line.split(',,').slice(-1)[0]), 'भाई मैंने ऐसा कभी नहीं कहा');
    assert.equal(line.includes('Wait सुनो'), false);
  }

  // 6 mixed English+Hindi words in Clip 2 -> 6 word-level Dialogue events spanning 0:00:05.00 to 0:00:08.00
  assert.equal(clip2Lines.length, 6);
  assert.ok(clip2Lines[0].startsWith('Dialogue: 0,0:00:05.00,0:00:05.50,'));
  assert.ok(clip2Lines[5].startsWith('Dialogue: 0,0:00:07.50,0:00:08.00,'));
  for (const line of clip2Lines) {
    assert.equal(stripAssOverrideTags(line.split(',,').slice(-1)[0]), 'Wait सुनो मेरी बात ध्यान से');
    assert.equal(line.includes('भाई मैंने'), false);
  }

  // Verify controlled line wrapping for longer sentences
  const wrapped = formatWordHighlightedAssCueText(
    ['This', 'is', 'a', 'longer', 'spoken', 'sentence', 'inside', 'vertical', 'video'],
    3
  );
  assert.ok(wrapped.includes('\\N'));
  assert.equal(stripAssOverrideTags(wrapped), 'This is a longer spoken sentence inside vertical video');
});

test('Precision Word-Level Caption Synchronization: acoustic forced alignment handles pauses, fast/slow speech, stretched words, Hindi, English, mixed speech, and multi-clip offsets', () => {
  // Helper to synthesize realistic 8kHz s16le PCM audio with exact ground-truth spoken word bursts and dips
  function synthesizeSpeechPcm(
    totalDurationMs: number,
    wordBursts: Array<{ startMs: number; endMs: number; amplitude?: number; freqHz?: number }>
  ): Uint8Array {
    const sampleRate = 8000;
    const totalSamples = Math.round((totalDurationMs / 1000) * sampleRate);
    const pcm = new Uint8Array(totalSamples * 2);
    const view = new DataView(pcm.buffer);

    for (let s = 0; s < totalSamples; s++) {
      const tMs = (s / sampleRate) * 1000;
      let val = 0.002 * Math.sin(2 * Math.PI * 60 * (s / sampleRate)); // quiet room floor
      for (const b of wordBursts) {
        if (tMs >= b.startMs && tMs <= b.endMs) {
          const span = Math.max(1, b.endMs - b.startMs);
          const rel = (tMs - b.startMs) / span;
          // Natural attack/decay speech syllable envelope
          const env = Math.sin(Math.PI * rel);
          const amp = (b.amplitude ?? 0.65) * env;
          const freq = b.freqHz ?? 210;
          val = amp * Math.sin(2 * Math.PI * freq * (s / sampleRate));
          break;
        }
      }
      const s16 = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
      view.setInt16(s * 2, s16, true);
    }
    return pcm;
  }

  // 1 & 2. Speech with a LONG PAUSE ("Wait... listen to me"):
  // "Wait..." spoken [0ms -> 420ms], LONG PAUSE [420ms -> 1850ms], "listen" [1850ms -> 2250ms], "to" [2260ms -> 2460ms], "me" [2470ms -> 3000ms]
  const pausePcm = synthesizeSpeechPcm(3000, [
    { startMs: 0, endMs: 420, amplitude: 0.75 },
    { startMs: 1850, endMs: 2250, amplitude: 0.7 },
    { startMs: 2260, endMs: 2460, amplitude: 0.55 },
    { startMs: 2470, endMs: 2980, amplitude: 0.72 },
  ]);
  const pauseEnv = extractPcmS16LeRmsEnvelope(pausePcm, 8000, 10);
  const pauseCue = { index: 1, startMs: 0, endMs: 3000, text: 'Wait... listen to me' };

  // Naive equal division would start "listen" at 750ms (1,100ms too early during dead silence!)
  const alignedPauseWords = deriveWordCaptionsFromClipSubtitles([pauseCue], {
    audioEnvelope: pauseEnv,
  });
  assert.equal(alignedPauseWords.length, 4);
  assert.equal(alignedPauseWords[0].word, 'Wait...');
  assert.equal(alignedPauseWords[0].startMs, 0);
  // "Wait..." must stay visible/highlighted through the pause until "listen" actually starts around 1850ms!
  assert.ok(
    Math.abs(alignedPauseWords[1].startMs - 1850) <= 30,
    `Expected "listen" onset near 1850ms, got ${alignedPauseWords[1].startMs}ms`
  );
  assert.ok(
    Math.abs(alignedPauseWords[2].startMs - 2260) <= 40,
    `Expected "to" onset near 2260ms, got ${alignedPauseWords[2].startMs}ms`
  );
  assert.ok(
    Math.abs(alignedPauseWords[3].startMs - 2470) <= 40,
    `Expected "me" onset near 2470ms, got ${alignedPauseWords[3].startMs}ms`
  );
  assert.equal(alignedPauseWords[3].endMs, 3000);

  // 3. Very fast speech (6 words in 1200ms)
  const fastPcm = synthesizeSpeechPcm(1200, [
    { startMs: 0, endMs: 170 },
    { startMs: 190, endMs: 360 },
    { startMs: 380, endMs: 560 },
    { startMs: 580, endMs: 770 },
    { startMs: 790, endMs: 970 },
    { startMs: 990, endMs: 1190 },
  ]);
  const fastEnv = extractPcmS16LeRmsEnvelope(fastPcm, 8000, 10);
  const fastCue = { index: 2, startMs: 0, endMs: 1200, text: 'We need to move right now' };
  const fastWords = alignCueWordsWithAudioAndProsody(fastCue, fastEnv);
  assert.equal(fastWords.length, 6);
  const fastTruth = [0, 190, 380, 580, 790, 990];
  for (let i = 0; i < 6; i++) {
    assert.ok(
      Math.abs(fastWords[i].startMs - fastTruth[i]) <= 30,
      `Fast word #${i} (${fastWords[i].word}) expected near ${fastTruth[i]}ms, got ${fastWords[i].startMs}ms`
    );
  }

  // 4. Stretched words and sentence endings ("Nooooooo way!")
  const stretchedProfile = computeWordAcousticProsodicProfile('Nooooooo', false);
  const shortProfile = computeWordAcousticProsodicProfile('to', false);
  assert.ok(
    stretchedProfile.spokenWeight > shortProfile.spokenWeight * 3,
    'Stretched word must receive significantly higher phonetic weight than a short function word'
  );

  // 5, 6 & 7. Hindi-only, English-only, and Mixed Hindi-English speech with acoustic bursts
  const mixedPcm = synthesizeSpeechPcm(3200, [
    { startMs: 0, endMs: 420 },      // Wait
    { startMs: 950, endMs: 1420 },   // सुनो (after 530ms pause)
    { startMs: 1460, endMs: 1920 },  // मेरी
    { startMs: 1960, endMs: 2420 },  // बात
    { startMs: 2460, endMs: 2860 },  // ध्यान
    { startMs: 2890, endMs: 3190 },  // से
  ]);
  const mixedEnv = extractPcmS16LeRmsEnvelope(mixedPcm, 8000, 10);
  const mixedCue = { index: 3, startMs: 0, endMs: 3200, text: 'Wait, सुनो मेरी बात ध्यान से' };
  const mixedWords = deriveWordCaptionsFromClipSubtitles([mixedCue], { audioEnvelope: mixedEnv });
  assert.equal(mixedWords.length, 6);
  const mixedTruth = [0, 950, 1460, 1960, 2460, 2890];
  for (let i = 0; i < mixedWords.length; i++) {
    assert.ok(
      Math.abs(mixedWords[i].startMs - mixedTruth[i]) <= 30,
      `Mixed word #${i} (${mixedWords[i].word}) expected near ${mixedTruth[i]}ms, got ${mixedWords[i].startMs}ms`
    );
  }

  // 8. Multiple clips from different positions in the same recording (e.g. 00:05:00 = 300,000ms)
  const sourceCues = [
    { index: 10, startMs: 302000, endMs: 305000, text: 'Wait... listen to me' },
  ];
  // Clip extracted at [300,000ms -> 310,000ms]; cue is clip-relative [2000ms -> 5000ms]
  const relCues = extractClipRelativeSubtitles(sourceCues, 300000, 310000);
  assert.equal(relCues[0].startMs, 2000);
  assert.equal(relCues[0].endMs, 5000);

  // Synthesize 10s clip audio where the cue is spoken at [2000ms..5000ms] with the 1.43s pause after "Wait..."
  const clipPcm = synthesizeSpeechPcm(10000, [
    { startMs: 2000, endMs: 2420, amplitude: 0.75 },
    { startMs: 3850, endMs: 4250, amplitude: 0.7 },
    { startMs: 4260, endMs: 4460, amplitude: 0.55 },
    { startMs: 4470, endMs: 4980, amplitude: 0.72 },
  ]);
  const clipEnv = extractPcmS16LeRmsEnvelope(clipPcm, 8000, 10);
  const assWithAudio = generateClipAssSubtitleScript(relCues, 10000, { audioEnvelope: clipEnv });
  const assLines = assWithAudio.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(assLines.length, 4);
  // First word "Wait..." starts at 0:00:02.00 and holds through the pause until ~0:00:03.85!
  assert.ok(assLines[0].startsWith('Dialogue: 0,0:00:02.00,0:00:03.8'));
  // Second word "listen" starts at ~0:00:03.85 when speech actually resumes!
  assert.ok(assLines[1].startsWith('Dialogue: 0,0:00:03.8'));
});


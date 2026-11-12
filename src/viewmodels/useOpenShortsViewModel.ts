import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ClipArtifact,
  LocalVideoFile,
  MasterAudioPayload,
  NavigationTab,
  OpenShortsApiClip,
  JobStage,
  UnifiedMediaSource,
  validateSourceInput,
  validateMandatoryPipelinePayloads,
  mapOpenShortsClipsToArtifacts,
  readChunkAsArrayBuffer,
  resolveAdaptiveChunkSizeBytes,
  formatChunkUploadFailureMessage,
  buildClipDownloadUrl,
} from '../utils/pipelineLogic';

export interface SnackbarNotification {
  id: number;
  message: string;
  badge?: string;
}

interface OpenShortsStatusResponse {
  job_id: string;
  status: JobStage;
  stageMessage?: string;
  unifiedSource?: UnifiedMediaSource;
  logs?: string[];
  result?: {
    clips?: OpenShortsApiClip[];
  } | null;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Uploads a file using raw binary chunks (application/octet-stream) with idempotent retries
 * and exact byte-offset tracking.
 */
async function uploadFileInRawChunks(
  file: File,
  kind: 'video' | 'audio',
  onProgress?: (percent: number, transferredBytes: number) => void
): Promise<string> {
  const initRes = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
      totalSizeBytes: file.size,
      kind,
    }),
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ detail: 'Failed to initialize upload.' }));
    throw new Error(err.detail || 'Upload initialization rejected.');
  }

  const { uploadId, chunkSizeBytes } = (await initRes.json()) as {
    uploadId: string;
    chunkSizeBytes: number;
  };

  let byteOffset = 0;
  let chunkIndex = 0;

  while (byteOffset < file.size) {
    let retries = 0;
    let uploaded = false;
    let lastFailureReason = '';

    while (!uploaded && retries < 3) {
      const attemptChunkSize = resolveAdaptiveChunkSizeBytes(chunkSizeBytes, retries);
      const nextOffset = Math.min(file.size, byteOffset + attemptChunkSize);

      try {
        const chunkBuffer = await readChunkAsArrayBuffer(file, byteOffset, nextOffset);
        const chunkRes = await fetch('/api/upload/chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Id': uploadId,
            'X-Chunk-Index': String(chunkIndex),
            'X-Byte-Offset': String(byteOffset),
          },
          body: chunkBuffer,
        });

        if (chunkRes.ok) {
          uploaded = true;
          byteOffset = nextOffset;
          chunkIndex++;
          const pct = Math.round((byteOffset / file.size) * 100);
          onProgress?.(pct, byteOffset);
        } else {
          const errPayload = (await chunkRes.json().catch(() => null)) as {
            errorCode?: string;
            detail?: string;
          } | null;
          if (errPayload?.errorCode || errPayload?.detail) {
            lastFailureReason = `HTTP ${chunkRes.status}${
              errPayload.errorCode ? ` ${errPayload.errorCode}` : ''
            }${errPayload.detail ? `: ${errPayload.detail}` : ''}`;
          } else {
            lastFailureReason = `HTTP ${chunkRes.status} ${chunkRes.statusText || 'Upload rejected'}`.trim();
          }
          retries++;
          await new Promise((r) => setTimeout(r, 400 * retries));
        }
      } catch (err) {
        if (err instanceof Error) {
          const prefix = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
          lastFailureReason = `${prefix}${err.message}`;
        } else {
          lastFailureReason = String(err || 'Network or file read error');
        }
        retries++;
        await new Promise((r) => setTimeout(r, 400 * retries));
      }
    }

    if (!uploaded) {
      throw new Error(formatChunkUploadFailureMessage(file.name, chunkIndex, lastFailureReason));
    }
  }

  // Complete and verify upload via FFprobe on server
  const completeRes = await fetch('/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });

  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ detail: 'Upload verification failed.' }));
    throw new Error(err.detail || 'Upload completion verification failed.');
  }

  return uploadId;
}

export function useOpenShortsViewModel() {
  const [activeTab, setActiveTab] = useState<NavigationTab>('uploads');
  const [urlInput, setUrlInput] = useState<string>('');
  const [localFile, setLocalFile] = useState<LocalVideoFile | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState<number>(0);

  // Mandatory Frontend Payloads initialized empty (no demo/fake data)
  const [transcriptText, setTranscriptText] = useState<string>('');
  const [transcriptFileName, setTranscriptFileName] = useState<string>('');
  const [masterAudio, setMasterAudio] = useState<MasterAudioPayload | null>(null);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);

  // Clips initialized empty (no demo/fake clips)
  const [clips, setClips] = useState<ClipArtifact[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [exportingClipId, setExportingClipId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarNotification | null>(null);

  const activePollingAbortControllerRef = useRef<AbortController | null>(null);

  const triggerSnackbar = useCallback((message: string, badge?: string) => {
    setSnackbar({ id: Date.now(), message, badge });
  }, []);

  useEffect(() => {
    if (!snackbar) return;
    const timer = window.setTimeout(() => {
      setSnackbar(null);
    }, 3600);
    return () => window.clearTimeout(timer);
  }, [snackbar]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (activePollingAbortControllerRef.current) {
        activePollingAbortControllerRef.current.abort();
      }
    };
  }, []);

  // Playback progress loop when viewing rendered segment without native video element
  useEffect(() => {
    if (!isPlaying || clips.length === 0) return;
    const activeClip = clips.find((c) => c.id === selectedClipId);
    if (!activeClip || activeClip.videoUrl) return;

    const interval = window.setInterval(() => {
      setClips((prevClips) =>
        prevClips.map((clip) => {
          if (clip.id !== selectedClipId) return clip;
          const nextSec =
            clip.currentSeconds + 1 >= clip.durationSeconds ? 0 : clip.currentSeconds + 1;
          return { ...clip, currentSeconds: nextSec };
        })
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isPlaying, selectedClipId, clips]);

  const handleUrlChange = (value: string) => {
    setUrlInput(value);
    if (validationError) {
      setValidationError(null);
    }
  };

  const handleFileSelect = (file: LocalVideoFile | null) => {
    setLocalFile(file);
    setVideoDurationMs(file?.durationMs && file.durationMs > 0 ? file.durationMs : 0);
    if (file && validationError) {
      setValidationError(null);
    }
  };

  const handleTranscriptChange = (newText: string, fileName?: string) => {
    setTranscriptText(newText);
    if (fileName !== undefined) {
      setTranscriptFileName(fileName);
    }
    if (validationError) {
      setValidationError(null);
    }
  };

  const handleMasterAudioSelect = (audio: MasterAudioPayload | null) => {
    setMasterAudio(audio);
    if (validationError) {
      setValidationError(null);
    }
  };

  // Dispatches validated user input + mandatory payloads to the Lightweight OpenShorts Backend
  const dispatchToOpenShortsBackend = async () => {
    if (isGenerating) return;

    const sourceValidation = validateSourceInput(urlInput, localFile);
    if (!sourceValidation.valid) {
      setValidationError(sourceValidation.errorMessage || 'Provide a valid video URL or file.');
      return;
    }

    if (!masterAudio || !masterAudio.rawFile) {
      setValidationError('Pre-extracted master audio (.mp3/.wav) file is required.');
      return;
    }

    if (!transcriptText.trim()) {
      setValidationError('Manual timecoded transcript (.srt/.txt) is required.');
      return;
    }

    // Client-side precheck for duration sync if local video file has probed duration
    if (
      localFile &&
      videoDurationMs > 0 &&
      masterAudio.durationMs > 0 &&
      Math.abs(videoDurationMs - masterAudio.durationMs) > 2500
    ) {
      setValidationError('Audio/video duration mismatch exceeds 2.5s sync tolerance.');
      return;
    }

    setValidationError(null);
    setIsGenerating(true);

    if (activePollingAbortControllerRef.current) {
      activePollingAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    activePollingAbortControllerRef.current = abortController;

    try {
      let videoUploadId: string | undefined = localFile?.uploadedId;

      // 1. Upload Local Video Binary in raw chunks if local file chosen and not already uploaded
      if (sourceValidation.sourceType === 'file' && localFile?.rawFile) {
        if (!videoUploadId) {
          setPipelineStage('Uploading video (0%)...');
          videoUploadId = await uploadFileInRawChunks(
            localFile.rawFile,
            'video',
            (pct) => setPipelineStage(`Uploading video (${pct}%)...`)
          );
          setLocalFile((prev) => (prev ? { ...prev, uploadedId: videoUploadId } : prev));
        }
      }

      // 2. Upload Master Audio Binary in raw chunks if not already uploaded
      let audioUploadId = masterAudio.uploadedId;
      if (!audioUploadId) {
        setPipelineStage('Uploading master audio (0%)...');
        audioUploadId = await uploadFileInRawChunks(
          masterAudio.rawFile,
          'audio',
          (pct) => setPipelineStage(`Uploading master audio (${pct}%)...`)
        );
        setMasterAudio((prev) => (prev ? { ...prev, uploadedId: audioUploadId } : prev));
      }

      // 3. Submit Job
      setPipelineStage('Submitting processing job...');
      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          url: sourceValidation.sourceType === 'url' ? sourceValidation.normalizedSource : undefined,
          videoUploadId,
          audioUploadId,
          transcriptText,
          acknowledged: true,
        }),
      });

      if (!processRes.ok) {
        const errBody = (await processRes.json().catch(() => ({}))) as { detail?: string };
        setValidationError(errBody.detail || 'OpenShorts validation rejected the request.');
        setIsGenerating(false);
        setPipelineStage(null);
        return;
      }

      const { job_id: jobId } = (await processRes.json()) as { job_id: string };

      // 4. Polling until terminal state (with 5-minute timeout)
      const startTime = Date.now();
      const MAX_POLL_TIME_MS = 5 * 60 * 1000;
      let consecutiveErrors = 0;

      while (!abortController.signal.aborted) {
        if (Date.now() - startTime > MAX_POLL_TIME_MS) {
          throw new Error('Processing timed out after 5 minutes.');
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (abortController.signal.aborted) break;

        try {
          const statusRes = await fetch(`/api/status/${jobId}`, {
            signal: abortController.signal,
          });

          if (!statusRes.ok) {
            consecutiveErrors++;
            if (consecutiveErrors > 4) {
              throw new Error('Lost connection to processing server.');
            }
            continue;
          }

          consecutiveErrors = 0;
          const statusData = (await statusRes.json()) as OpenShortsStatusResponse;

          // Update UI with granular server stage message
          if (statusData.stageMessage) {
            setPipelineStage(statusData.stageMessage);
          } else if (statusData.status === 'validating') {
            setPipelineStage('Verifying A/V sync...');
          } else if (statusData.status === 'analyzing') {
            setPipelineStage('Gemini hook detection...');
          } else if (statusData.status === 'extracting') {
            setPipelineStage('Targeted FFmpeg slicing...');
          } else if (statusData.status === 'transcribing') {
            setPipelineStage('Aligning subtitles...');
          } else if (statusData.status === 'rendering') {
            setPipelineStage('Burning 9:16 captions...');
          }

          if (statusData.status === 'completed' && statusData.result?.clips) {
            const mappedClips = mapOpenShortsClipsToArtifacts(statusData.result.clips);
            setClips(mappedClips);
            setSelectedClipId(mappedClips[0]?.id || '');
            setIsGenerating(false);
            setPipelineStage(null);
            setActiveTab('clips');
            triggerSnackbar(
              `Generated ${mappedClips.length} vertical 9:16 clips`,
              'OpenShorts'
            );
            return;
          }

          if (statusData.status === 'failed' || statusData.status === 'cancelled') {
            setValidationError(statusData.error?.message || 'Pipeline execution failed.');
            setIsGenerating(false);
            setPipelineStage(null);
            return;
          }
        } catch (pollErr) {
          if (abortController.signal.aborted) return;
          consecutiveErrors++;
          if (consecutiveErrors > 4) {
            throw pollErr;
          }
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        setValidationError(
          err instanceof Error ? err.message : 'Unable to complete OpenShorts processing.'
        );
      }
    } finally {
      setIsGenerating(false);
      setPipelineStage(null);
    }
  };

  const handleSelectClip = (clipId: string) => {
    setSelectedClipId(clipId);
    setIsPlaying(false);
  };

  const handleTogglePlay = () => {
    if (clips.length === 0) return;
    setIsPlaying((prev) => !prev);
  };

  const handleStopPlay = () => {
    setIsPlaying(false);
    setClips((prev) =>
      prev.map((clip) => (clip.id === selectedClipId ? { ...clip, currentSeconds: 0 } : clip))
    );
  };

  const handleVideoTimeUpdate = (clipId: string, currentSeconds: number) => {
    setClips((prev) =>
      prev.map((clip) => (clip.id === clipId ? { ...clip, currentSeconds } : clip))
    );
  };

  const handleVideoLoadedMetadata = (clipId: string, durationSeconds: number) => {
    setClips((prev) =>
      prev.map((clip) => (clip.id === clipId ? { ...clip, durationSeconds } : clip))
    );
  };

  const handleExportSingleClip = async (clip: ClipArtifact, exportQuality: string) => {
    if (exportingClipId) return;

    const resolved = buildClipDownloadUrl(clip, exportQuality);
    if (!resolved) {
      triggerSnackbar('Export failed: Clip video URL is missing.', 'Error');
      return;
    }

    const { downloadUrl, fileName } = resolved;
    setExportingClipId(clip.id);

    try {
      // 1. Fetch and verify actual rendered MP4 binary from backend
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status} while exporting clip.`);
      }

      const rawBlob = await response.blob();
      if (!rawBlob || rawBlob.size <= 0) {
        throw new Error('Exported MP4 artifact is empty.');
      }

      const mp4Blob =
        rawBlob.type === 'video/mp4'
          ? rawBlob
          : new Blob([rawBlob], { type: 'video/mp4' });

      // 2. Trigger Blob ObjectURL download with delayed cleanup so mobile browsers finish reading
      const blobUrl = URL.createObjectURL(mp4Blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();

      // 3. When running inside a mobile preview iframe (e.g. Android Chrome WebView / iframe),
      // also trigger a hidden attachment iframe to hand the stream directly to Android DownloadManager / MediaScanner
      if (typeof window !== 'undefined' && window.self !== window.top) {
        const dlFrame = document.createElement('iframe');
        dlFrame.style.display = 'none';
        dlFrame.src = downloadUrl;
        document.body.appendChild(dlFrame);
        window.setTimeout(() => {
          if (dlFrame.parentNode) {
            dlFrame.parentNode.removeChild(dlFrame);
          }
        }, 60000);
      }

      window.setTimeout(() => {
        if (link.parentNode) {
          link.parentNode.removeChild(link);
        }
        URL.revokeObjectURL(blobUrl);
      }, 60000);

      triggerSnackbar(
        `Saved ${fileName} (${clip.durationSeconds}s) to device storage / Gallery`,
        exportQuality
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save clip to device storage.';
      triggerSnackbar(`Export failed: ${msg}`, 'Error');
    } finally {
      setExportingClipId(null);
    }
  };

  return {
    activeTab,
    setActiveTab,
    urlInput,
    handleUrlChange,
    localFile,
    handleFileSelect,
    transcriptText,
    transcriptFileName,
    handleTranscriptChange,
    masterAudio,
    handleMasterAudioSelect,
    validationError,
    isGenerating,
    pipelineStage,
    dispatchToOpenShortsBackend,
    clips,
    selectedClipId,
    handleSelectClip,
    isPlaying,
    setIsPlaying,
    handleTogglePlay,
    handleStopPlay,
    handleVideoTimeUpdate,
    handleVideoLoadedMetadata,
    handleExportSingleClip,
    exportingClipId,
    snackbar,
    triggerSnackbar,
  };
}

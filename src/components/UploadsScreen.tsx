import React, { useRef } from 'react';
import {
  Settings,
  Link2,
  ArrowRight,
  CloudUpload,
  Sparkles,
  ChevronRight,
  X,
  CheckCircle2,
  FileText,
  Music,
  AlertCircle,
} from 'lucide-react';
import { BrandLogoMark, CoralPlayGraphic } from './CoralPlayGraphic';
import { BottomNavBar } from './BottomNavBar';
import {
  LocalVideoFile,
  MasterAudioPayload,
  NavigationTab,
  formatFileSize,
  snapshotFileToMemory,
} from '../utils/pipelineLogic';

interface UploadsScreenProps {
  urlInput: string;
  onUrlChange: (value: string) => void;
  localFile: LocalVideoFile | null;
  onFileSelect: (file: LocalVideoFile | null) => void;
  transcriptFileName: string;
  onTranscriptChange: (text: string, fileName?: string) => void;
  masterAudio: MasterAudioPayload | null;
  onMasterAudioSelect: (audio: MasterAudioPayload | null) => void;
  validationError: string | null;
  isGenerating: boolean;
  pipelineStage: string | null;
  onGenerateClips: () => void;
  onOpenSettings: () => void;
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  navIdPrefix?: string;
}

function probeMediaDurationMs(file: File, kind: 'video' | 'audio'): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const el = document.createElement(kind);
    el.preload = 'metadata';
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
    };
    el.onloadedmetadata = () => {
      const durationMs =
        Number.isFinite(el.duration) && el.duration > 0
          ? Math.round(el.duration * 1000)
          : 0;
      cleanup();
      resolve(durationMs);
    };
    el.onerror = () => {
      cleanup();
      resolve(0);
    };
    el.src = objectUrl;
  });
}

export const UploadsScreen: React.FC<UploadsScreenProps> = ({
  urlInput,
  onUrlChange,
  localFile,
  onFileSelect,
  transcriptFileName,
  onTranscriptChange,
  masterAudio,
  onMasterAudioSelect,
  validationError,
  isGenerating,
  pipelineStage,
  onGenerateClips,
  onOpenSettings,
  activeTab,
  onSelectTab,
  navIdPrefix = 'screen1',
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const picked = inputEl.files?.[0];
    if (!picked) {
      inputEl.value = '';
      return;
    }
    try {
      const safeFile = await snapshotFileToMemory(picked);
      const durationMs = await probeMediaDurationMs(safeFile, 'video');
      onFileSelect({
        name: safeFile.name,
        sizeBytes: safeFile.size,
        mimeType: safeFile.type || 'video/mp4',
        durationMs,
        rawFile: safeFile,
      });
    } finally {
      inputEl.value = '';
    }
  };

  const handleTranscriptFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const picked = inputEl.files?.[0];
    if (!picked) {
      inputEl.value = '';
      return;
    }
    try {
      const text = await picked.text();
      onTranscriptChange(text, picked.name);
    } finally {
      inputEl.value = '';
    }
  };

  const handleAudioFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputEl = e.target;
    const picked = inputEl.files?.[0];
    if (!picked) {
      inputEl.value = '';
      return;
    }
    try {
      const safeFile = await snapshotFileToMemory(picked);
      const lower = safeFile.name.toLowerCase();
      const format: 'mp3' | 'wav' = lower.endsWith('.wav') ? 'wav' : 'mp3';
      const durationMs = await probeMediaDurationMs(safeFile, 'audio');
      onMasterAudioSelect({
        fileName: safeFile.name,
        format,
        sizeBytes: safeFile.size,
        durationMs,
        rawFile: safeFile,
      });
    } finally {
      inputEl.value = '';
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onGenerateClips();
    }
  };

  return (
    <section
      aria-label="Uploads and Generation Screen"
      className="relative flex h-full w-full flex-col justify-between overflow-hidden bg-gradient-to-b from-[#FDF6F3] via-[#FBF0EB] to-[#F7E6DF] text-[#2B1E1C]"
    >
      {/* Top Soft Ambient Radial Accent */}
      <div
        className="pointer-events-none absolute -right-12 top-14 h-64 w-64 rounded-full bg-gradient-to-br from-[#F7B6A6]/35 via-[#EE8E7A]/20 to-transparent blur-2xl"
        aria-hidden="true"
      />

      {/* Scrollable Main Content Container */}
      <div className="flex flex-1 flex-col justify-between overflow-y-auto px-6 pt-5 pb-4 no-scrollbar">
        {/* Top App Bar */}
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <div className="flex items-center gap-2.5">
              <BrandLogoMark />
              <div className="text-[22px] leading-none tracking-tight whitespace-nowrap">
                <span className="font-bold text-[#2B1E1C]">Flux</span>
                <span className="font-normal text-[#D45645]">Clip</span>
              </div>
            </div>
            <span className="mt-1.5 pl-0.5 text-[9.5px] font-semibold tracking-[0.22em] text-[#9E847E] uppercase">
              Video Repurposing Studio
            </span>
          </div>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Studio settings"
            className="flex h-11 w-11 items-center justify-center rounded-full text-[#6E5651] transition-colors hover:bg-[#F2DFD8] active:scale-95 focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
          >
            <Settings className="h-5 w-5" strokeWidth={1.9} />
          </button>
        </div>

        {/* Hero Section: Headline + 3D Translucent Coral Play Icon */}
        <div className="my-auto py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 pr-1">
              <h1 className="font-serif-display text-[38px] sm:text-[40px] font-semibold leading-[1.06] tracking-[-0.02em] text-[#2B1E1C]">
                Create.
                <br />
                Edit. Share.
              </h1>
              <p className="mt-3 max-w-[195px] text-[13.5px] leading-[1.4] font-normal text-[#8C726C]">
                Turn any video into short, engaging clips.
              </p>
            </div>

            <CoralPlayGraphic />
          </div>

          {/* Inputs Section (YouTube URL / Direct Video URL / Local Video Upload + Mandatory Payloads) */}
          <div className="mt-4 space-y-3">
            {/* Remote URL Field: Supports YouTube URLs & Direct Video URLs (.mp4, .mov, .webm) */}
            <div>
              <div
                className={`flex h-14 items-center gap-3 rounded-2xl border bg-[#FCF6F4]/90 px-3.5 shadow-[0_4px_14px_rgba(180,115,100,0.08)] transition-all ${
                  validationError
                    ? 'border-[#C93B2B] ring-2 ring-[#C93B2B]/15'
                    : 'border-[#ECD7CF] focus-within:border-[#DF5B49] focus-within:ring-2 focus-within:ring-[#DF5B49]/15'
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#F5E4DE] text-[#7D635D]">
                  <Link2 className="h-[18px] w-[18px] -rotate-45" strokeWidth={2} />
                </div>

                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <label
                    htmlFor={`${navIdPrefix}-url-input`}
                    className="text-[13px] font-semibold leading-tight text-[#2B1E1C]"
                  >
                    Paste video URL
                  </label>
                  <input
                    id={`${navIdPrefix}-url-input`}
                    type="url"
                    value={urlInput}
                    onChange={(e) => onUrlChange(e.target.value)}
                    onKeyDown={handleUrlKeyDown}
                    placeholder="YouTube or direct MP4/MOV/WebM links"
                    aria-invalid={Boolean(validationError)}
                    className="w-full truncate bg-transparent text-[11.5px] text-[#5A433E] placeholder:text-[#A48B85] focus:outline-none"
                  />
                </div>

                <button
                  type="button"
                  onClick={onGenerateClips}
                  aria-label="Submit video URL"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#EA715D] to-[#D14838] text-white shadow-sm shadow-[#D14838]/30 transition-transform hover:brightness-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
                >
                  <ArrowRight className="h-4 w-4" strokeWidth={2.2} />
                </button>
              </div>

              {/* Validation Error */}
              {validationError && (
                <div
                  role="alert"
                  className="mt-1.5 flex items-start justify-between gap-2 px-1 text-[11.5px] font-medium text-[#C23627]"
                >
                  <span className="break-words leading-snug">{validationError}</span>
                </div>
              )}
            </div>

            {/* OR Divider */}
            <div className="flex items-center gap-3 px-2" aria-hidden="true">
              <div className="h-px flex-1 bg-[#E7D0C8]" />
              <span className="text-[11px] font-semibold tracking-wider text-[#9A807A] uppercase">
                OR
              </span>
              <div className="h-px flex-1 bg-[#E7D0C8]" />
            </div>

            {/* Local Video Upload Card (Card / Surface) */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
              onChange={handleFileChange}
              className="hidden"
              aria-label="Upload local video file"
            />

            {localFile ? (
              <div className="flex min-h-[68px] w-full items-center justify-between gap-3 rounded-2xl border border-[#DF5B49]/40 bg-[#F9E7E1] px-4 py-2.5 shadow-[0_4px_14px_rgba(180,115,100,0.08)]">
                <div className="flex min-w-0 items-center gap-3.5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#DF5B49]/15 text-[#C94233]">
                    <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-semibold text-[#2B1E1C]">
                      {localFile.name}
                    </p>
                    <p className="text-[11px] text-[#7F655F]">
                      {formatFileSize(localFile.sizeBytes)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onFileSelect(null)}
                  aria-label="Remove selected video file"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#7F655F] hover:bg-[#EED5CD] hover:text-[#2B1E1C]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group flex min-h-[68px] w-full items-center gap-4 rounded-2xl border border-[#ECD7CF] bg-[#FBF2EE]/90 px-4 py-2.5 text-left shadow-[0_4px_14px_rgba(180,115,100,0.07)] transition-all hover:border-[#E2BFB4] hover:bg-[#F9EAE4] active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F4DDD5] text-[#D25A49] transition-transform group-hover:scale-105">
                  <CloudUpload className="h-5 w-5" strokeWidth={1.9} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-[#2B1E1C]">
                    Upload a video
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-[#8E756F]">
                    MP4, MOV &amp; more formats
                  </p>
                </div>
              </button>
            )}

            {/* Mandatory Frontend Payloads: Timecoded Transcript (.srt/.txt) & Master Audio (.mp3/.wav) */}
            <input
              ref={transcriptInputRef}
              type="file"
              accept=".srt,.txt,text/plain"
              onChange={handleTranscriptFileChange}
              className="hidden"
              aria-label="Upload timecoded transcript file"
            />
            <input
              ref={audioInputRef}
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              onChange={handleAudioFileChange}
              className="hidden"
              aria-label="Upload master audio file"
            />

            <div className="grid grid-cols-2 gap-2.5 pt-0.5">
              <div className="group relative flex h-11 items-center rounded-xl border border-[#ECD7CF] bg-[#FBF2EE]/80 px-3 transition-colors hover:border-[#E2BFB4] hover:bg-[#F9EAE4]">
                <button
                  type="button"
                  onClick={() => transcriptInputRef.current?.click()}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[#C84335]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-[#2B1E1C]">
                      {transcriptFileName || 'Upload Transcript'}
                    </p>
                    <p className="truncate text-[9.5px] text-[#8E756F]">
                      {transcriptFileName ? 'Timecodes loaded' : '.srt or .txt timecodes'}
                    </p>
                  </div>
                </button>
                {transcriptFileName && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTranscriptChange('', '');
                    }}
                    aria-label="Remove transcript file"
                    className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#8E756F] hover:bg-[#ECD7CF] hover:text-[#2B1E1C]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="group relative flex h-11 items-center rounded-xl border border-[#ECD7CF] bg-[#FBF2EE]/80 px-3 transition-colors hover:border-[#E2BFB4] hover:bg-[#F9EAE4]">
                <button
                  type="button"
                  onClick={() => audioInputRef.current?.click()}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
                >
                  <Music className="h-3.5 w-3.5 shrink-0 text-[#C84335]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-[#2B1E1C]">
                      {masterAudio ? masterAudio.fileName : 'Upload Master Audio'}
                    </p>
                    <p className="truncate text-[9.5px] text-[#8E756F]">
                      {masterAudio ? formatFileSize(masterAudio.sizeBytes) : '.mp3 or .wav audio'}
                    </p>
                  </div>
                </button>
                {masterAudio && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMasterAudioSelect(null);
                    }}
                    aria-label="Remove master audio file"
                    className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#8E756F] hover:bg-[#ECD7CF] hover:text-[#2B1E1C]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Primary CTA Button & Pipeline Alerts */}
        <div className="pt-1.5 space-y-2">
          {validationError && (
            <div
              role="alert"
              className="flex items-start justify-between gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-800"
            >
              <div className="flex items-start gap-1.5 min-w-0">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                <span className="break-words leading-snug">{validationError}</span>
              </div>
              {validationError.toLowerCase().includes('gemini') && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="shrink-0 text-[11px] font-bold text-rose-700 underline hover:text-rose-900"
                >
                  Configure Key
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={onGenerateClips}
            disabled={isGenerating}
            className="relative flex h-14 w-full items-center justify-between rounded-full bg-gradient-to-r from-[#E67763] via-[#DC5645] to-[#C63D2F] px-6 text-white shadow-[0_10px_22px_rgba(204,66,51,0.34)] transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D84E3E]"
          >
            <Sparkles className="h-4 w-4 shrink-0 text-[#FFE1D9]" strokeWidth={2} />
            <span className="text-[15.5px] font-medium tracking-tight whitespace-nowrap">
              {isGenerating && pipelineStage ? pipelineStage : 'Generate clips'}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[#FFE1D9]" strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* Bottom Navigation: Compact 56dp bar */}
      <BottomNavBar
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        idPrefix={navIdPrefix}
      />
    </section>
  );
};

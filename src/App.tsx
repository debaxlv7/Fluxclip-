import React, { useState } from 'react';
import { Check, X, SlidersHorizontal, Film } from 'lucide-react';
import { useOpenShortsViewModel } from './viewmodels/useOpenShortsViewModel';
import { UploadsScreen } from './components/UploadsScreen';
import { ClipsScreen } from './components/ClipsScreen';
import { GeminiSettingsSection } from './components/GeminiSettingsSection';

export default function App() {
  const {
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
  } = useOpenShortsViewModel();

  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [burnInCaptions, setBurnInCaptions] = useState<boolean>(true);
  const [speakerTracking, setSpeakerTracking] = useState<boolean>(true);
  const [exportQuality, setExportQuality] = useState<'1080p' | '720p'>('1080p');

  return (
    <main className="relative flex min-h-dvh w-full flex-col items-center justify-center bg-gradient-to-br from-[#F6EAE5] via-[#F2E0D9] to-[#EAD3CA] md:p-6 lg:p-8">
      {/* Adaptive Smartphone & Tablet Container */}
      <div className="relative flex h-dvh w-full max-w-5xl flex-col items-center justify-center md:h-auto md:grid md:grid-cols-2 md:gap-7 lg:gap-10">
        {/* Screen 1: Uploads & Generation Screen */}
        <div
          className={`h-dvh w-full flex-col overflow-hidden bg-[#FDF6F3] md:h-[780px] md:max-w-[392px] md:justify-self-end md:rounded-[40px] md:border-[6px] md:border-[#3A2B28] md:shadow-[0_24px_60px_rgba(58,43,40,0.18)] transition-all ${
            activeTab === 'uploads'
              ? 'flex md:ring-4 md:ring-[#DF5B49]/25'
              : 'hidden md:flex'
          }`}
        >
          <div className="flex-1 overflow-hidden">
            <UploadsScreen
              urlInput={urlInput}
              onUrlChange={handleUrlChange}
              localFile={localFile}
              onFileSelect={handleFileSelect}
              transcriptFileName={transcriptFileName}
              onTranscriptChange={handleTranscriptChange}
              masterAudio={masterAudio}
              onMasterAudioSelect={handleMasterAudioSelect}
              validationError={validationError}
              isGenerating={isGenerating}
              pipelineStage={pipelineStage}
              onGenerateClips={dispatchToOpenShortsBackend}
              onOpenSettings={() => setIsSettingsOpen(true)}
              activeTab="uploads"
              onSelectTab={setActiveTab}
              navIdPrefix="uploads-pane"
            />
          </div>
        </div>

        {/* Screen 2: Clips & Export Screen */}
        <div
          className={`h-dvh w-full flex-col overflow-hidden bg-[#FDF6F3] md:h-[780px] md:max-w-[392px] md:justify-self-start md:rounded-[40px] md:border-[6px] md:border-[#3A2B28] md:shadow-[0_24px_60px_rgba(58,43,40,0.18)] transition-all ${
            activeTab === 'clips'
              ? 'flex md:ring-4 md:ring-[#DF5B49]/25'
              : 'hidden md:flex'
          }`}
        >
          <div className="flex-1 overflow-hidden">
            <ClipsScreen
              clips={clips}
              selectedClipId={selectedClipId}
              onSelectClip={handleSelectClip}
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onStopPlay={handleStopPlay}
              onExportSingleClip={(clip) => handleExportSingleClip(clip, exportQuality)}
              exportingClipId={exportingClipId}
              onVideoTimeUpdate={handleVideoTimeUpdate}
              onVideoLoadedMetadata={handleVideoLoadedMetadata}
              onVideoEnded={() => setIsPlaying(false)}
              activeTab="clips"
              onSelectTab={setActiveTab}
              navIdPrefix="clips-pane"
            />
          </div>
        </div>
      </div>

      {/* Material 3 Studio Settings Sheet (Includes Transcript Timecode Inspector) */}
      {isSettingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="studio-settings-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 backdrop-blur-xs sm:items-center"
        >
          <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-3xl border border-[#EAD4CC] bg-[#FDF6F3] p-6 text-[#2B1E1C] shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-[#EAD4CC]/60">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#F4DDD5] text-[#C84335]">
                  <SlidersHorizontal className="h-4 w-4" />
                </div>
                <div>
                  <h3
                    id="studio-settings-title"
                    className="font-serif-display text-base font-semibold text-[#2B1E1C]"
                  >
                    Studio &amp; Gemini AI Settings
                  </h3>
                  <p className="text-[11px] text-[#7D6661]">Configure Gemini API keys and pipeline extraction</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close studio settings"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#7D6661] hover:bg-[#EFE0DA]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4 overflow-y-auto pr-1 text-xs">
              {/* Dedicated Gemini API Configuration Section */}
              <GeminiSettingsSection onNotify={triggerSnackbar} />

              <div className="pt-2 border-t border-[#EAD4CC]/60 space-y-3">
                <h4 className="font-semibold text-xs text-[#2B1E1C]">Transcript &amp; Pipeline Payloads</h4>

                <div>
                  <label
                    htmlFor="manual-transcript-editor"
                    className="mb-1 block font-semibold text-[#2B1E1C]"
                  >
                    Manual Timecoded Transcript (.srt / .txt)
                  </label>
                  <textarea
                    id="manual-transcript-editor"
                    rows={3}
                    value={transcriptText}
                    onChange={(e) => handleTranscriptChange(e.target.value)}
                    placeholder="00:00:00,000 --> 00:00:30,000"
                    className="font-mono-tabular w-full rounded-2xl border border-[#ECD7CF] bg-[#FAF0EC] p-3 text-[11px] leading-relaxed text-[#3B2A27] focus:border-[#C84335] focus:outline-none"
                  />
                </div>

                <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-[#ECD7CF] bg-[#FAF0EC] px-3.5 py-2.5">
                  <div>
                    <p className="font-semibold text-[#2B1E1C]">Targeted FFmpeg Segment Slice</p>
                    <p className="text-[11px] text-[#7D6661]">Range-based 9:16 extraction without full download</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={speakerTracking}
                    onChange={(e) => setSpeakerTracking(e.target.checked)}
                    className="h-4 w-4 accent-[#C84335]"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-[#ECD7CF] bg-[#FAF0EC] px-3.5 py-2.5">
                  <div>
                    <p className="font-semibold text-[#2B1E1C]">Short-Slice Faster-Whisper Captions</p>
                    <p className="text-[11px] text-[#7D6661]">Word-level alignment on sliced MP3 only</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={burnInCaptions}
                    onChange={(e) => setBurnInCaptions(e.target.checked)}
                    className="h-4 w-4 accent-[#C84335]"
                  />
                </label>

                <div className="flex items-center justify-between rounded-2xl border border-[#ECD7CF] bg-[#FAF0EC] px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <Film className="h-4 w-4 text-[#C84335]" />
                    <span className="font-semibold text-[#2B1E1C]">Render Resolution</span>
                  </div>
                  <div className="flex gap-1 rounded-full bg-[#EFE0DA] p-0.5">
                    {(['1080p', '720p'] as const).map((res) => (
                      <button
                        key={res}
                        type="button"
                        onClick={() => setExportQuality(res)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                          exportQuality === res
                            ? 'bg-[#C84335] text-white'
                            : 'text-[#6E5651] hover:text-[#2B1E1C]'
                        }`}
                      >
                        {res}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-[#EAD4CC]/60 flex justify-end">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="h-9 rounded-full bg-gradient-to-r from-[#E26D59] to-[#C63D2F] px-5 text-xs font-semibold text-white shadow-xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Material 3 Feedback Snackbar (Positioned above 56dp Bottom Navigation Bar) */}
      {snackbar && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-16 md:bottom-5 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-[#5A423D] bg-[#2B1E1C] px-4 py-2 text-xs font-medium text-[#FDF6F3] shadow-lg"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-[#F2826D]" strokeWidth={2.5} />
          <span className="truncate whitespace-nowrap">{snackbar.message}</span>
          {snackbar.badge && (
            <span className="font-mono-tabular shrink-0 text-[10px] text-[#E6B8AE]">
              · {snackbar.badge}
            </span>
          )}
        </div>
      )}
    </main>
  );
}

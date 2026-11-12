import React, { useRef } from 'react';
import { Play, Pause, Square, Download, ChevronRight } from 'lucide-react';
import {
  ClipArtifact,
  NavigationTab,
  formatClockTime,
  formatSegmentTitle,
  formatSegmentDurationLabel,
} from '../utils/pipelineLogic';
import { PodcasterFrame } from './PodcasterFrame';
import { BottomNavBar } from './BottomNavBar';

interface ClipsScreenProps {
  clips: ClipArtifact[];
  selectedClipId: string;
  onSelectClip: (clipId: string) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStopPlay: () => void;
  onExportSingleClip: (clip: ClipArtifact) => void;
  exportingClipId?: string | null;
  onVideoTimeUpdate?: (clipId: string, currentSeconds: number) => void;
  onVideoLoadedMetadata?: (clipId: string, durationSeconds: number) => void;
  onVideoEnded?: () => void;
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  navIdPrefix?: string;
}

export const ClipsScreen: React.FC<ClipsScreenProps> = ({
  clips,
  selectedClipId,
  onSelectClip,
  isPlaying,
  onTogglePlay,
  onStopPlay,
  onExportSingleClip,
  exportingClipId,
  onVideoTimeUpdate,
  onVideoLoadedMetadata,
  onVideoEnded,
  activeTab,
  onSelectTab,
  navIdPrefix = 'screen2',
}) => {
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const selectedClip: ClipArtifact | null =
    clips.find((c) => c.id === selectedClipId) || clips[0] || null;

  const progressRatio =
    selectedClip && selectedClip.durationSeconds > 0
      ? Math.min(100, Math.max(0, (selectedClip.currentSeconds / selectedClip.durationSeconds) * 100))
      : 0;

  const handleScrollRight = () => {
    if (carouselRef.current) {
      carouselRef.current.scrollBy({ left: 160, behavior: 'smooth' });
    }
  };

  return (
    <section
      aria-label="Clips and Export Screen"
      className="relative flex h-full w-full flex-col justify-between overflow-hidden bg-gradient-to-b from-[#FDF6F3] via-[#FBF0EB] to-[#F7E6DF] text-[#2B1E1C]"
    >
      {/* Scrollable Main Content Container */}
      <div className="flex flex-1 flex-col justify-between overflow-y-auto px-6 pt-5 pb-3 no-scrollbar">
        {/* Header: "Generated Clips" (35sp, Clean Serif) */}
        <div>
          <h2 className="font-serif-display text-[33px] sm:text-[35px] font-semibold leading-[1.1] tracking-[-0.02em] text-[#2B1E1C]">
            Generated Clips
          </h2>

          {/* Carousel: 1-row horizontal clip selection grid (LazyRow) */}
          <div className="relative mt-3.5 flex items-center">
            {clips.length > 0 ? (
              <>
                <div
                  ref={carouselRef}
                  role="listbox"
                  aria-label="Generated clips carousel"
                  className="flex w-full items-center gap-2.5 overflow-x-auto pr-6 pb-1 no-scrollbar"
                >
                  {clips.map((clip) => {
                    const isSelected = selectedClip ? clip.id === selectedClip.id : false;
                    return (
                      <button
                        key={clip.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => onSelectClip(clip.id)}
                        className="group flex shrink-0 flex-col items-start text-left focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
                      >
                        <div
                          className={`relative h-[52px] w-[76px] overflow-hidden rounded-xl transition-all ${
                            isSelected
                              ? 'ring-2 ring-[#D54B3B] shadow-sm'
                              : 'opacity-80 ring-1 ring-[#DFC7BF] group-hover:opacity-100'
                          }`}
                        >
                          <PodcasterFrame
                            clip={clip}
                            isPlaying={false}
                            showCaptions={false}
                            compactThumbnail={true}
                          />
                          <span className="font-mono-tabular absolute right-1 bottom-1 rounded bg-black/70 px-1 py-0.2 text-[9px] font-medium text-white">
                            {clip.durationSeconds}s
                          </span>
                        </div>
                        <span
                          className={`mt-1 text-[11.5px] leading-tight whitespace-nowrap ${
                            isSelected
                              ? 'font-bold text-[#2B1E1C]'
                              : 'font-medium text-[#7D6661]'
                          }`}
                        >
                          {clip.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Carousel scroll affordance */}
                <button
                  type="button"
                  onClick={handleScrollRight}
                  aria-label="Scroll clips right"
                  className="absolute -right-1 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-[#FDF6F3]/90 text-[#6E5651] shadow-sm ring-1 ring-[#E7D0C8] hover:bg-white"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            ) : (
              <div className="flex h-[68px] w-full items-center justify-center rounded-2xl border border-dashed border-[#E2C9C0] bg-[#FAF0EC]/60 px-4 text-center text-[11.5px] font-medium text-[#8C726C]">
                No clips generated yet
              </div>
            )}
          </div>
        </div>

        {/* Preview Player: Large 9:16 vertical video with scrubber */}
        <div className="my-2 flex flex-col items-center">
          <div className="relative aspect-[9/16] w-[178px] sm:w-[192px] overflow-hidden rounded-[22px] bg-[#141213] shadow-[0_12px_28px_rgba(43,30,28,0.22)] ring-1 ring-black/10">
            <PodcasterFrame
              clip={selectedClip}
              isPlaying={isPlaying}
              showCaptions={true}
              compactThumbnail={false}
              onVideoTimeUpdate={(sec) =>
                selectedClip && onVideoTimeUpdate?.(selectedClip.id, sec)
              }
              onVideoLoadedMetadata={(dur) =>
                selectedClip && onVideoLoadedMetadata?.(selectedClip.id, dur)
              }
              onVideoEnded={onVideoEnded}
            />
          </div>

          {/* Player Control Bar & Read-Only Pre-Rendered Scrubber */}
          <div className="mt-3 flex w-full items-center gap-2.5 px-1">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={!selectedClip}
              aria-label={isPlaying ? 'Pause clip preview' : 'Play clip preview'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#3D2B28] transition-colors hover:bg-[#EFE0DA] active:scale-95 disabled:opacity-40"
            >
              {isPlaying ? (
                <Pause className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>

            <button
              type="button"
              onClick={onStopPlay}
              disabled={!selectedClip}
              aria-label="Reset clip preview to default frame"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#6E5651] transition-colors hover:bg-[#EFE0DA] active:scale-95 disabled:opacity-40"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>

            {/* Scrubber Track (Pre-rendered artifact playback progress) */}
            <div
              className="relative flex h-5 flex-1 items-center"
              role="progressbar"
              aria-label="Clip playback progress"
              aria-valuenow={selectedClip ? selectedClip.currentSeconds : 0}
              aria-valuemin={0}
              aria-valuemax={selectedClip ? selectedClip.durationSeconds : 0}
            >
              <div className="h-[4px] w-full overflow-hidden rounded-full bg-[#E6CFC7]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#E26A56] to-[#C84335] transition-all duration-200"
                  style={{ width: `${progressRatio}%` }}
                />
              </div>
              <div
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-[#C84335] shadow-xs ring-2 ring-[#FDF6F3] transition-all duration-200"
                style={{ left: `${progressRatio}%` }}
              />
            </div>

            <span className="font-mono-tabular shrink-0 text-[11px] font-medium text-[#7D6661]">
              {selectedClip
                ? `${formatClockTime(selectedClip.currentSeconds)} / ${formatClockTime(selectedClip.durationSeconds)}`
                : '0:00 / 0:00'}
            </span>
          </div>

          {/* Clip Metadata */}
          <div className="mt-1.5 text-center">
            {selectedClip ? (
              <>
                <p className="text-[12.5px] font-semibold text-[#3B2A27]">
                  {formatSegmentTitle(selectedClip)}
                </p>
                <p className="text-[12px] font-medium text-[#6E5651]">
                  {formatSegmentDurationLabel(selectedClip)}
                </p>
              </>
            ) : (
              <p className="text-[12px] font-medium text-[#8C726C]">
                No active clip selected
              </p>
            )}
          </div>
        </div>

        {/* Dual Exports: "Batch Export Zip ↓" (L - Inert UI Placeholder) | "Export Clip ↓" (R - Single Clip Export) */}
        <div className="grid grid-cols-2 items-center gap-3 pt-1">
          {/* Inert UI Placeholder for Non-Native Batch Export (Strictly no bundling/ZIP logic) */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="flex h-12 cursor-default items-center justify-center gap-1.5 rounded-full border border-[#E4C9C0] bg-[#F7E6DF]/80 px-3.5 text-[12.5px] font-medium text-[#9A7E77] shadow-2xs select-none"
          >
            <span className="truncate whitespace-nowrap">Batch Export Zip</span>
            <Download className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          </button>

          {/* Primary Single Clip Export CTA (MediaStore.Video / Gallery trigger) */}
          <button
            type="button"
            disabled={!selectedClip || Boolean(exportingClipId)}
            onClick={() => selectedClip && onExportSingleClip(selectedClip)}
            className="flex h-12 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#E26D59] via-[#D44D3D] to-[#BC3729] px-4 text-[13px] font-medium text-white shadow-[0_8px_18px_rgba(198,61,47,0.32)] transition-all hover:brightness-105 active:scale-[0.98] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
          >
            <span className="truncate whitespace-nowrap">
              {selectedClip && exportingClipId === selectedClip.id ? 'Saving Clip...' : 'Export Clip'}
            </span>
            <Download className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
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

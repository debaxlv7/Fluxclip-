import React, { useEffect, useRef } from 'react';
import { Film } from 'lucide-react';
import { ClipArtifact } from '../utils/pipelineLogic';

interface PodcasterFrameProps {
  clip: ClipArtifact | null;
  isPlaying?: boolean;
  showCaptions?: boolean;
  compactThumbnail?: boolean;
  onVideoTimeUpdate?: (currentSeconds: number) => void;
  onVideoLoadedMetadata?: (durationSeconds: number) => void;
  onVideoEnded?: () => void;
}

export const PodcasterFrame: React.FC<PodcasterFrameProps> = ({
  clip,
  isPlaying = false,
  showCaptions = true,
  compactThumbnail = false,
  onVideoTimeUpdate,
  onVideoLoadedMetadata,
  onVideoEnded,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoUrl = clip?.videoUrl;
  const thumbnailUrl = clip?.thumbnailUrl;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoUrl || compactThumbnail) return;
    if (isPlaying) {
      el.play().catch(() => {
        // Ignore autoplay restrictions
      });
    } else {
      el.pause();
    }
  }, [isPlaying, videoUrl, compactThumbnail]);

  if (!clip) {
    return (
      <div className="relative flex h-full w-full flex-col items-center justify-center bg-[#161314] p-4 text-center select-none">
        <Film className="h-7 w-7 text-[#6E5651]" strokeWidth={1.6} />
        <p className="mt-2 text-[11.5px] font-medium leading-snug text-[#9E847E]">
          No video clip loaded
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#161314] select-none">
      {compactThumbnail && thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={`${clip.label} thumbnail`}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : videoUrl ? (
        <video
          ref={videoRef}
          src={compactThumbnail ? `${videoUrl}#t=0.1` : videoUrl}
          poster={thumbnailUrl}
          playsInline
          muted={compactThumbnail}
          preload="metadata"
          onTimeUpdate={(e) => {
            if (!compactThumbnail && onVideoTimeUpdate) {
              onVideoTimeUpdate(Math.floor(e.currentTarget.currentTime));
            }
          }}
          onLoadedMetadata={(e) => {
            if (
              !compactThumbnail &&
              onVideoLoadedMetadata &&
              Number.isFinite(e.currentTarget.duration)
            ) {
              onVideoLoadedMetadata(Math.max(1, Math.round(e.currentTarget.duration)));
            }
          }}
          onEnded={() => {
            if (!compactThumbnail && onVideoEnded) {
              onVideoEnded();
            }
          }}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-b from-[#1E191A] to-[#120F10] p-3 text-center">
          <Film
            className={compactThumbnail ? 'h-4 w-4 text-[#8E756F]' : 'h-7 w-7 text-[#8E756F]'}
            strokeWidth={1.6}
          />
          {!compactThumbnail && (
            <span className="font-mono-tabular mt-1.5 text-[10px] text-[#9E847E]">
              {clip.startTimestamp} – {clip.endTimestamp}
            </span>
          )}
        </div>
      )}

      {/* Bottom Measured Contrast Scrim for Burned-In Captions */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />

      {/* Fallback Captions Only When No Rendered Video Artifact Is Loaded (MP4 Already Has Burned-In Subtitles) */}
      {showCaptions && !compactThumbnail && !videoUrl && (clip.captionLines[0] || clip.captionLines[1]) && (
        <div className="pointer-events-none absolute inset-x-3 bottom-7 flex flex-col items-center text-center">
          <p className="font-sans-ui text-[13px] sm:text-sm font-extrabold leading-snug tracking-tight drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">
            {(() => {
              const allWords = `${clip.captionLines[0]} ${clip.captionLines[1] || ''}`
                .trim()
                .split(/\s+/)
                .filter(Boolean);
              const currentMs = clip.currentSeconds * 1000;
              let activeIdx = 0;
              if (clip.wordCaptions && clip.wordCaptions.length === allWords.length) {
                const foundIdx = clip.wordCaptions.findIndex(
                  (w, i) =>
                    currentMs >= w.startMs &&
                    (currentMs < w.endMs || i === clip.wordCaptions!.length - 1)
                );
                if (foundIdx >= 0) {
                  activeIdx = foundIdx;
                }
              } else if (allWords.length > 0 && clip.durationSeconds > 0) {
                activeIdx = Math.min(
                  allWords.length - 1,
                  Math.floor((clip.currentSeconds / clip.durationSeconds) * allWords.length)
                );
              }
              return allWords.map((word, idx) => (
                <span
                  key={`${word}-${idx}`}
                  className={
                    idx < activeIdx
                      ? 'text-[#C4C8CC]'
                      : idx === activeIdx
                        ? 'inline-block scale-105 text-[#FFD728]'
                        : 'text-white'
                  }
                >
                  {word}{' '}
                </span>
              ));
            })()}
          </p>
        </div>
      )}
    </div>
  );
};

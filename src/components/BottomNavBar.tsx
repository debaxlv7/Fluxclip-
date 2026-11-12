import React from 'react';
import { NavigationTab } from '../utils/pipelineLogic';

interface BottomNavBarProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  idPrefix?: string;
}

export const BottomNavBar: React.FC<BottomNavBarProps> = ({
  activeTab,
  onSelectTab,
  idPrefix = 'main',
}) => {
  const isUploads = activeTab === 'uploads';
  const isClips = activeTab === 'clips';

  return (
    <nav
      aria-label={`${idPrefix} bottom navigation`}
      className="h-14 shrink-0 border-t border-[#EAD5CD] bg-[#FAF0EC]/95 px-6 backdrop-blur-md"
    >
      <div className="mx-auto grid h-full max-w-xs grid-cols-2 items-center gap-4">
        {/* Uploads Tab */}
        <button
          type="button"
          onClick={() => onSelectTab('uploads')}
          aria-current={isUploads ? 'page' : undefined}
          className="group flex h-12 w-full flex-col items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
        >
          <div
            className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${
              isUploads
                ? 'bg-[#F4D5CC] text-[#C84335]'
                : 'text-[#7D6661] group-hover:bg-[#F3E2DC]/60 group-hover:text-[#4A3834]'
            }`}
          >
            {/* Material Home / Upload House Icon matching PRD */}
            <svg
              viewBox="0 0 24 24"
              className="h-[19px] w-[19px]"
              fill="none"
              stroke="currentColor"
              strokeWidth={isUploads ? 2.1 : 1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10.5L12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-9z" />
              <path d="M12 16V9" />
              <path d="M9.5 11.5L12 9l2.5 2.5" />
            </svg>
          </div>
          <span
            className={`mt-0.5 text-[11px] leading-none tracking-tight whitespace-nowrap ${
              isUploads ? 'font-semibold text-[#C84335]' : 'font-medium text-[#7D6661]'
            }`}
          >
            Uploads
          </span>
        </button>

        {/* Clips Tab */}
        <button
          type="button"
          onClick={() => onSelectTab('clips')}
          aria-current={isClips ? 'page' : undefined}
          className="group flex h-12 w-full flex-col items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-[#D84E3E]"
        >
          <div
            className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${
              isClips
                ? 'bg-[#F4D5CC] text-[#C84335]'
                : 'text-[#7D6661] group-hover:bg-[#F3E2DC]/60 group-hover:text-[#4A3834]'
            }`}
          >
            {/* Material Clapperboard / Clips Icon matching PRD */}
            <svg
              viewBox="0 0 24 24"
              className="h-[19px] w-[19px]"
              fill="none"
              stroke="currentColor"
              strokeWidth={isClips ? 2.1 : 1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <path d="M3.5 9.5h17" />
              <path d="M8.5 4.5l-2 5" />
              <path d="M14.5 4.5l-2 5" />
            </svg>
          </div>
          <span
            className={`mt-0.5 text-[11px] leading-none tracking-tight whitespace-nowrap ${
              isClips ? 'font-semibold text-[#C84335]' : 'font-medium text-[#7D6661]'
            }`}
          >
            Clips
          </span>
        </button>
      </div>
    </nav>
  );
};

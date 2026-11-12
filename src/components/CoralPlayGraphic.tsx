import React from 'react';

export const BrandLogoMark: React.FC = () => {
  return (
    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#F07A65] via-[#DF5443] to-[#C43B2E] shadow-sm shadow-[#D84E3E]/30">
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5 translate-x-0.5 text-white drop-shadow-xs"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M6.5 4.8c0-1.1 1.2-1.8 2.1-1.2l11.2 7.2c.9.6.9 1.8 0 2.4L8.6 20.4c-.9.6-2.1-.1-2.1-1.2V4.8z" />
      </svg>
    </div>
  );
};

export const CoralPlayGraphic: React.FC = () => {
  return (
    <div
      className="relative flex h-36 w-36 sm:h-40 sm:w-40 shrink-0 items-center justify-center select-none"
      aria-hidden="true"
    >
      {/* Ambient soft coral radial glow */}
      <div className="absolute inset-1 rounded-full bg-gradient-to-tr from-[#F29D89]/40 via-[#EA715B]/25 to-transparent blur-xl" />

      {/* Sparkle accents matching Screen 1 specification */}
      <svg
        viewBox="0 0 200 200"
        className="relative h-full w-full drop-shadow-[0_18px_24px_rgba(204,72,56,0.26)]"
        fill="none"
      >
        <defs>
          <linearGradient id="coralOuterBody" x1="25" y1="20" x2="165" y2="175" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFBCA8" stopOpacity="0.95" />
            <stop offset="38%" stopColor="#F27963" stopOpacity="0.92" />
            <stop offset="78%" stopColor="#DC4D3D" stopOpacity="0.94" />
            <stop offset="100%" stopColor="#B83226" stopOpacity="0.96" />
          </linearGradient>

          <linearGradient id="coralSideBevel" x1="40" y1="30" x2="155" y2="180" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#E6634E" />
            <stop offset="50%" stopColor="#C83D2F" />
            <stop offset="100%" stopColor="#9E261B" />
          </linearGradient>

          <linearGradient id="coralInnerCutout" x1="65" y1="55" x2="145" y2="145" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FADBD2" />
            <stop offset="50%" stopColor="#F4B7A7" />
            <stop offset="100%" stopColor="#DF7C68" />
          </linearGradient>

          <linearGradient id="specularRim" x1="35" y1="22" x2="150" y2="120" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
            <stop offset="55%" stopColor="#FFDAD0" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Top-right sparkle star */}
        <path
          d="M162 18C162 25 164 27 171 27C164 27 162 29 162 36C162 29 160 27 153 27C160 27 162 25 162 18Z"
          fill="#E58A77"
          opacity="0.78"
        />
        {/* Bottom-left soft sparkle star */}
        <path
          d="M28 148C28 153 29.5 154.5 34.5 154.5C29.5 154.5 28 156 28 161C28 156 26.5 154.5 21.5 154.5C26.5 154.5 28 153 28 148Z"
          fill="#E58A77"
          opacity="0.65"
        />

        {/* Soft bottom contact shadow */}
        <ellipse cx="102" cy="176" rx="48" ry="9" fill="#C45B4A" opacity="0.22" />

        {/* 3D Extruded Back/Depth Layer */}
        <path
          d="M46 44C46 28.5 63.2 19.2 76.4 27.3L164.5 81.5C177.1 89.2 177.1 107.5 164.5 115.2L76.4 169.4C63.2 177.5 46 168.2 46 152.7V44Z"
          transform="translate(-7, 7) rotate(-6 105 98)"
          fill="url(#coralSideBevel)"
          opacity="0.88"
        />

        {/* 3D Translucent Front Play Prism */}
        <g transform="rotate(-6 105 98)">
          <path
            d="M46 44C46 28.5 63.2 19.2 76.4 27.3L164.5 81.5C177.1 89.2 177.1 107.5 164.5 115.2L76.4 169.4C63.2 177.5 46 168.2 46 152.7V44Z"
            fill="url(#coralOuterBody)"
          />

          {/* Translucent Inner Recessed Triangle */}
          <path
            d="M73 68.5C73 61.8 80.4 57.7 86.1 61.2L133.5 90.4C138.9 93.7 138.9 101.6 133.5 104.9L86.1 134.1C80.4 137.6 73 133.5 73 126.8V68.5Z"
            fill="url(#coralInnerCutout)"
          />

          {/* Inner Cutout 3D Bevel Shadow */}
          <path
            d="M76 66C76 62 80.5 59.5 84 61.7L131 90.6C134.2 92.6 134.2 97.3 131 99.3L84 128.2C80.5 130.4 76 127.9 76 123.9V66Z"
            fill="#FCEBE6"
             opacity="0.88"
          />

          {/* Glass Specular Edge Highlight */}
          <path
            d="M48 44C48 30 63.6 21.6 75.5 28.9L162.5 82.4C168 85.8 170.8 91.2 170.8 96.6"
            stroke="url(#specularRim)"
            strokeWidth="4.5"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
};

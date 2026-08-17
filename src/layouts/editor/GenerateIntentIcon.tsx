/** Simple line icons for Generate intent cards. */

import type { GenerateIntentId } from "./previewIntent";

const svgProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function TextImageIcon() {
  return (
    <svg {...svgProps}>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="7.5" cy="8.5" r="1.25" />
      <path d="M3.5 14.5 7 11l2.5 2.5L13 10l3.5 4.5" />
      <path d="M6 2.5h8" />
    </svg>
  );
}

function ImageImageIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="5" width="10" height="8" rx="1" />
      <rect x="7.5" y="7.5" width="10" height="8" rx="1" />
      <path d="M10 11.5h5M10 13.5h3.5" />
    </svg>
  );
}

function TextVideoIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="5" width="11" height="10" rx="1.5" />
      <path d="M13.5 8.5 17.5 6v8L13.5 11.5" />
      <path d="M5 2.5h6" />
    </svg>
  );
}

function ImageVideoIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="3.5" width="7" height="6" rx="1" />
      <path d="M6 9.5v1.5" />
      <rect x="3.5" y="11" width="13" height="6" rx="1.25" />
      <path d="M8.5 13.2 12 14l-3.5.8V13.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ImageAudioVideoIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="4" width="8" height="7" rx="1" />
      <path d="M12 7.5v5.5M14.5 6v8.5M17 8v4.5" />
      <rect x="3.5" y="13" width="7" height="4" rx="1" />
    </svg>
  );
}

function VideoVideoIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2" y="5" width="7.5" height="6" rx="1" />
      <path d="M9.5 7.5 12 6v4L9.5 8.5" />
      <path d="M7 12.5h6M10 12.5v2" />
      <rect x="8.5" y="12" width="9" height="5.5" rx="1" />
    </svg>
  );
}

function ReferenceVideoIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="8.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="14.5" y="3.5" width="3.5" height="5" rx="1" />
      <rect x="3.5" y="11" width="13" height="6" rx="1.25" />
      <path d="M8.5 13.2 12 14l-3.5.8V13.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TextMusicIcon() {
  return (
    <svg {...svgProps}>
      <path d="M8 15.5a2 2 0 1 1-2-2" />
      <path d="M8 13.5V4.5l9-1.5v9" />
      <path d="M17 12a2 2 0 1 1-2-2" />
    </svg>
  );
}

function TextSpeechIcon() {
  return (
    <svg {...svgProps}>
      <path d="M4 5.5h9a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H8l-3.5 3v-3H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z" />
      <path d="M15.5 7.5c.9.5 1.5 1.4 1.5 2.5s-.6 2-1.5 2.5" />
    </svg>
  );
}

export function GenerateIntentIcon({
  intentId,
}: {
  intentId: GenerateIntentId;
}) {
  switch (intentId) {
    case "text_to_image":
      return <TextImageIcon />;
    case "image_to_image":
      return <ImageImageIcon />;
    case "text_to_video":
      return <TextVideoIcon />;
    case "image_to_video":
      return <ImageVideoIcon />;
    case "image_audio_to_video":
      return <ImageAudioVideoIcon />;
    case "video_to_video":
      return <VideoVideoIcon />;
    case "reference_to_video":
      return <ReferenceVideoIcon />;
    case "text_to_music":
      return <TextMusicIcon />;
    case "text_to_speech":
      return <TextSpeechIcon />;
    default:
      return <TextImageIcon />;
  }
}

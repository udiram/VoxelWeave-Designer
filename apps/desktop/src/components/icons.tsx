import type { SVGProps } from "react";

export type IconName =
  | "design" | "dicom" | "calibrate" | "prepare" | "send" | "verify"
  | "folder" | "chevronDown" | "chevronRight" | "chevronUp" | "more" | "plus"
  | "settings" | "info" | "database" | "cube" | "layers" | "eye" | "eyeOff"
  | "check" | "warning" | "alert" | "crosshair" | "crop" | "link" | "play"
  | "pause" | "stepBack" | "stepForward" | "home" | "zoomIn" | "zoomOut"
  | "fit" | "lock" | "download" | "upload" | "file" | "scan" | "ruler"
  | "move" | "rotate" | "scale" | "union" | "subtract" | "intersect"
  | "refresh" | "search" | "checkCircle" | "arrowUpRight" | "external"
  | "grid" | "probe" | "target" | "menu" | "sliders" | "contrast" | "help"
  | "trash" | "copy" | "group" | "ungroup" | "align" | "unlock" | "rename";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props,
  };

  switch (name) {
    case "design": return <svg {...common}><path d="m5 19 4-4"/><path d="M7 21a2.8 2.8 0 1 0-4-4l9.5-9.5a2.8 2.8 0 0 1 4 4L7 21Z"/><path d="m14 5 5 5"/><path d="m16.5 2.5 5 5"/></svg>;
    case "dicom": return <svg {...common}><rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8 8h8M8 12h5M8 16h3"/><path d="M3 8v8M21 8v8"/></svg>;
    case "calibrate": return <svg {...common}><path d="M4 20 18.5 5.5"/><path d="m15 4 5 5"/><path d="M5 15h4M8 12h4M11 9h4M14 6h4"/></svg>;
    case "prepare": return <svg {...common}><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7"/><path d="M12 11v10"/><path d="m8 5 8 4"/></svg>;
    case "send": return <svg {...common}><path d="m21 3-7.2 18-3.4-7.4L3 10.2 21 3Z"/><path d="M10.4 13.6 21 3"/></svg>;
    case "verify": return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.7 2.7L16.5 9"/></svg>;
    case "folder": return <svg {...common}><path d="M3.5 6.5h6l2 2h9v9.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.5Z"/><path d="M3.5 9h17"/></svg>;
    case "chevronDown": return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
    case "chevronRight": return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case "chevronUp": return <svg {...common}><path d="m6 15 6-6 6 6"/></svg>;
    case "more": return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "settings": return <svg {...common}><path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-1.3-3.1h-.2a1.8 1.8 0 0 1 0-3.6h.2a1.8 1.8 0 0 0 1.3-3.1l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3.1-1.3V1.8a1.8 1.8 0 0 1 3.6 0V2a1.8 1.8 0 0 0 3.1 1.3l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 1.3 3.1h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-1.3 3.1Z"/></svg>;
    case "info": return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="M12 10.8v5M12 7.8v.2"/></svg>;
    case "database": return <svg {...common}><ellipse cx="12" cy="5.5" rx="7" ry="3"/><path d="M5 5.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6M5 11.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>;
    case "cube": return <svg {...common}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.4 7.7 7.6 4.2 7.6-4.2M12 12v9"/></svg>;
    case "layers": return <svg {...common}><path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/></svg>;
    case "eye": return <svg {...common}><path d="M3 12s3.4-5 9-5 9 5 9 5-3.4 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2"/></svg>;
    case "eyeOff": return <svg {...common}><path d="m4 4 16 16M10.6 7.2A9.6 9.6 0 0 1 12 7c5.6 0 9 5 9 5a15 15 0 0 1-3.2 3.2M6.4 6.4C4.3 7.7 3 9.5 3 12c0 0 3.4 5 9 5 1.3 0 2.5-.3 3.5-.7"/><path d="M9.8 9.8a3 3 0 0 0 4.4 4.4"/></svg>;
    case "check": return <svg {...common}><path d="m5 12 4.2 4.2L19 6.5"/></svg>;
    case "warning": return <svg {...common}><path d="m12 3 9 16H3L12 3Z"/><path d="M12 9v4M12 16v.2"/></svg>;
    case "alert": return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.2"/></svg>;
    case "crosshair": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>;
    case "crop": return <svg {...common}><path d="M8 3v13a2 2 0 0 0 2 2h11M16 21V8a2 2 0 0 0-2-2H3"/><path d="M3 8h5M16 16h5"/></svg>;
    case "link": return <svg {...common}><path d="M9.5 14.5 14.5 9.5"/><path d="M7 17H5.5a3.5 3.5 0 0 1 0-7H9M15 7h1.5a3.5 3.5 0 0 1 0 7H15"/></svg>;
    case "play": return <svg {...common}><path d="m9 6 9 6-9 6V6Z"/></svg>;
    case "pause": return <svg {...common}><path d="M8 5v14M16 5v14"/></svg>;
    case "stepBack": return <svg {...common}><path d="M6 5v14M18 6l-8 6 8 6V6Z"/></svg>;
    case "stepForward": return <svg {...common}><path d="M18 5v14M6 6l8 6-8 6V6Z"/></svg>;
    case "home": return <svg {...common}><path d="m4 11 8-7 8 7"/><path d="M6 10v9h12v-9M10 19v-5h4v5"/></svg>;
    case "zoomIn": return <svg {...common}><circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4 4M10.8 7.8v6M7.8 10.8h6"/></svg>;
    case "zoomOut": return <svg {...common}><circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4 4M7.8 10.8h6"/></svg>;
    case "fit": return <svg {...common}><path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4"/><path d="M8 8h8v8H8z"/></svg>;
    case "lock": return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>;
    case "unlock": return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="1.5"/><path d="M16 10V7a4 4 0 0 0-7.4-2.1"/></svg>;
    case "trash": return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>;
    case "copy": return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5H5v11h3"/></svg>;
    case "group": return <svg {...common}><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M14 4h6v6M4 14v6h6"/></svg>;
    case "ungroup": return <svg {...common}><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M14 4h6v6M4 14v6h6" strokeDasharray="2 2"/></svg>;
    case "align": return <svg {...common}><path d="M4 4v16M8 7h10M8 12h7M8 17h12"/></svg>;
    case "rename": return <svg {...common}><path d="M4 18h4l11-11-4-4L4 14v4Z"/><path d="m13 5 4 4M10 18h10"/></svg>;
    case "download": return <svg {...common}><path d="M12 4v11M8 11l4 4 4-4M5 19h14"/></svg>;
    case "upload": return <svg {...common}><path d="M12 15V4M8 8l4-4 4 4M5 19h14"/></svg>;
    case "file": return <svg {...common}><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></svg>;
    case "scan": return <svg {...common}><path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M7 12h10"/></svg>;
    case "ruler": return <svg {...common}><path d="m4 17 13-13 3 3L7 20H4v-3Z"/><path d="m10 6 3 3M7 9l3 3M13 3l3 3"/></svg>;
    case "move": return <svg {...common}><path d="M12 3v18M3 12h18M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2M3 12l2-2M3 12l2 2M21 12l-2-2M21 12l-2 2"/></svg>;
    case "rotate": return <svg {...common}><path d="M5 8a7.5 7.5 0 1 1-.4 7"/><path d="M5 4v4h4"/></svg>;
    case "scale": return <svg {...common}><path d="M5 19 19 5M5 13V5h8M19 11v8h-8"/><path d="m5 5 5 5M19 19l-5-5"/></svg>;
    case "union": return <svg {...common}><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></svg>;
    case "subtract": return <svg {...common}><circle cx="9" cy="12" r="5"/><path d="M12 8a5 5 0 0 1 0 8"/></svg>;
    case "intersect": return <svg {...common}><path d="M8 5a7 7 0 0 0 0 14M16 5a7 7 0 0 1 0 14"/><path d="M8 5c2.8 0 5 3.1 5 7s-2.2 7-5 7"/></svg>;
    case "refresh": return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 9.2A7 7 0 0 1 18.5 7M18.8 14.8A7 7 0 0 1 5.5 17"/></svg>;
    case "search": return <svg {...common}><circle cx="10.8" cy="10.8" r="6.4"/><path d="m16 16 4 4"/></svg>;
    case "checkCircle": return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.7 2.7L16.5 9"/></svg>;
    case "arrowUpRight": return <svg {...common}><path d="M6 18 18 6M9 6h9v9"/></svg>;
    case "external": return <svg {...common}><path d="M13 5h6v6M19 5l-9 9"/><path d="M18 13v5H5V5h5"/></svg>;
    case "grid": return <svg {...common}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>;
    case "probe": return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>;
    case "target": return <svg {...common}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5V2M20.5 12H22M12 20.5V22M3.5 12H2"/></svg>;
    case "menu": return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16"/></svg>;
    case "sliders":
    case "contrast": return <svg {...common}><path d="M4 6h5M13 6h7M4 12h9M17 12h3M4 18h2M10 18h10"/><circle cx="11" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>;
    case "help": return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.6 2.6 0 1 1 4.6 1.7c-1 1.1-2.2 1.4-2.2 3M12 17v.2"/></svg>;
  }
}

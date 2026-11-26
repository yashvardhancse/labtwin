import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />
  </Icon>
);
export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2.2" />
  </Icon>
);
export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </Icon>
);
export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
  </Icon>
);
export const OpenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Icon>
);
export const ReplayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5" />
  </Icon>
);
export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);
export const ErrorIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.8v3.8M8 11h.01" strokeWidth="1.8" />
  </Icon>
);
export const WarningIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.2 14.2 13H1.8z" />
    <path d="M8 6.2v3.3M8 11.3h.01" strokeWidth="1.8" />
  </Icon>
);
export const SnowIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6.3 2.6 8 4.2l1.7-1.6M6.3 13.4 8 11.8l1.7 1.6" />
  </Icon>
);
export const ResetViewIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" />
    <circle cx="8" cy="8" r="1.6" />
  </Icon>
);
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </Icon>
);

/** LabTwin mark: a gantry over a cold plate with a droplet. */
export function LogoMark(props: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" {...props}>
      <rect x="2.5" y="3" width="17" height="2.4" rx="1.2" fill="var(--ink)" />
      <rect x="3" y="3" width="2.2" height="16" rx="1.1" fill="var(--ink)" />
      <rect x="16.8" y="3" width="2.2" height="16" rx="1.1" fill="var(--ink)" />
      <path d="M11 6v6.5" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 13.2c1.3 1.5 1.9 2.4 1.9 3.2a1.9 1.9 0 0 1-3.8 0c0-.8.6-1.7 1.9-3.2Z" fill="var(--cryo)" />
      <rect x="6" y="19" width="10" height="1.6" rx="0.8" fill="var(--cryo)" opacity="0.55" />
    </svg>
  );
}

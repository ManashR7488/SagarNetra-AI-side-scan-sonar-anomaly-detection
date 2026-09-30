import { useId } from 'react';
import { BRAND } from '../../config/brand';
import { cn } from '../../utils/cn';

/**
 * SagarNetra mark: a drop of ocean holding an open eye, with an amber iris (the colour used for detected
 * anomalies) and faint sonar rings radiating behind it. Same artwork as public/favicon.svg.
 */
export function LogoMark({ size = 36, className, title = BRAND.name }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', className)} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0E4D92" />
          <stop offset="1" stopColor="#03142A" />
        </linearGradient>
        <linearGradient id={`${id}drop`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7DD3FC" />
          <stop offset="1" stopColor="#0891B2" />
        </linearGradient>
        <radialGradient id={`${id}iris`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#FDE68A" />
          <stop offset="1" stopColor="#F59E0B" />
        </radialGradient>
        <clipPath id={`${id}tile`}><rect width="64" height="64" rx="15" /></clipPath>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}bg)`} />
      <g clipPath={`url(#${id}tile)`} fill="none" stroke="#38BDF8" strokeWidth="1.4">
        <circle cx="32" cy="40" r="25" opacity="0.22" />
        <circle cx="32" cy="40" r="31" opacity="0.12" />
      </g>
      <path d="M32 5 C27 12 12 27 12 40 A20 20 0 0 0 52 40 C52 27 37 12 32 5 Z" fill={`url(#${id}drop)`} />
      <path d="M15 40 Q32 25 49 40 Q32 55 15 40 Z" fill="#03142A" />
      <circle cx="32" cy="40" r="7" fill={`url(#${id}iris)`} />
      <circle cx="32" cy="40" r="3" fill="#03142A" />
      <circle cx="30" cy="38" r="1.2" fill="#FFFFFF" />
      <path d="M22 20 A14 14 0 0 1 28 14" fill="none" stroke="#E0F7FF" strokeWidth="2.4" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

/** Mark + two-tone wordmark. `tone`: 'light' (on white) or 'dark' (on navy). */
export default function Logo({ size = 36, tone = 'light', subtitle = BRAND.org, className }) {
  const [a, b] = BRAND.nameParts;
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <span className="leading-tight">
        <span className={cn('block font-extrabold tracking-tight', size >= 36 ? 'text-xl' : 'text-base')}>
          <span className={tone === 'dark' ? 'text-white' : 'text-slate-900'}>{a}</span>
          <span className={tone === 'dark' ? 'text-cyan-300' : 'text-sky-600'}>{b}</span>
        </span>
        {subtitle && (
          <span className={cn('block text-[10px] font-mono uppercase tracking-wider', tone === 'dark' ? 'text-slate-400' : 'text-slate-500')}>
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );
}

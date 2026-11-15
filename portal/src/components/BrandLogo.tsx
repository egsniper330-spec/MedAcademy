/** Official MedAcademy mark used by the mobile app, with portal-specific size classes. */

type BrandLogoVariant = 'full' | 'compact' | 'mark';

const SOURCES: Record<BrandLogoVariant, { light: string; dark: string; width: number; height: number }> = {
  full: {
    light: '/brand/medacademy-logo-full-light.png',
    dark: '/brand/medacademy-logo-full-dark.png',
    width: 800,
    height: 240,
  },
  compact: {
    light: '/brand/medacademy-logo-light.png',
    dark: '/brand/medacademy-logo-dark.png',
    width: 560,
    height: 128,
  },
  mark: {
    light: '/brand/medacademy-mark-light.png',
    dark: '/brand/medacademy-mark-dark.png',
    width: 400,
    height: 400,
  },
};

export function BrandLogo({
  variant = 'compact',
  className = '',
  decorative = false,
}: {
  variant?: BrandLogoVariant;
  className?: string;
  decorative?: boolean;
}) {
  const source = SOURCES[variant];
  return (
    <span className={`brand-logo brand-logo-${variant} ${className}`.trim()}>
      <img
        className="brand-logo-art brand-logo-light"
        src={source.light}
        width={source.width}
        height={source.height}
        alt={decorative ? '' : 'MedAcademy'}
        aria-hidden={decorative || undefined}
        decoding="async"
        draggable={false}
      />
      <img
        className="brand-logo-art brand-logo-dark"
        src={source.dark}
        width={source.width}
        height={source.height}
        alt={decorative ? '' : 'MedAcademy'}
        aria-hidden={decorative || undefined}
        decoding="async"
        draggable={false}
      />
    </span>
  );
}
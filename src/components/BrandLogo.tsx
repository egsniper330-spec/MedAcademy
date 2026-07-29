/**
 * BrandLogo — MedAcademy adaptive branding component.
 *
 * Variant guide:
 *   'auto'      — (default) full horizontal logo; picks light/dark automatically
 *   'light'     — full horizontal logo, light-mode colors (dark mark + text on transparent)
 *   'dark'      — full horizontal logo, dark-mode colors (light mark + text on transparent)
 *   'drawer'    — compact horizontal strip (mark + wordmark), optimised for drawer header
 *   'monogram'  — M + cap only; auto light/dark; for headers, drawers, loading screens
 *   'icon'      — square app icon (navy bg); only where OS mandates, e.g. about screens
 *   'splash'    — full splash composition; for custom splash screens
 *
 * Sizing:
 *   `size`       — controls the HEIGHT in logical pixels. Width scales from aspect ratio.
 *   `width`      — override width explicitly (use with monogram / icon)
 *
 * Usage:
 *   <BrandLogo />                                  // full logo, auto light/dark, h=56
 *   <BrandLogo variant="drawer" size={48} />       // drawer header (mark + wordmark)
 *   <BrandLogo variant="monogram" size={40} />     // compact spaces
 *   <BrandLogo variant="auto"    size={120} />     // auth screens
 *   <BrandLogo variant="icon"    size={80}  />     // about page
 */
import { useColorScheme } from 'react-native';
import { Image } from 'expo-image';

// Aspect ratios derived from pixel dimensions of each asset
const ASSETS = {
  light:        require('../../assets/brand/logo-light.png'),
  dark:         require('../../assets/brand/logo-dark.png'),
  drawer_l:     require('../../assets/brand/drawer-logo-light.png'),
  drawer_d:     require('../../assets/brand/drawer-logo-dark.png'),
  mono_l:       require('../../assets/brand/monogram-light.png'),
  mono_d:       require('../../assets/brand/monogram-dark.png'),
  icon:         require('../../assets/icon.png'),
  splash:       require('../../assets/brand/splash.png'),
} as const;

const RATIOS = {
  logo:         800  / 240,   // ~3.33:1  horizontal wordmark
  drawer:       560  / 128,   // ~4.375:1 compact drawer strip
  monogram:     1,            // 1:1
  icon:         1,            // 1:1
  splash:       1242 / 2688,  // portrait
};

type Variant = 'auto' | 'light' | 'dark' | 'drawer' | 'monogram' | 'icon' | 'splash';

interface BrandLogoProps {
  variant?: Variant;
  /** Height in logical pixels — width is computed from aspect ratio unless `width` is set */
  size?: number;
  /** Explicit width override */
  width?: number;
}

export function BrandLogo({ variant = 'auto', size, width }: BrandLogoProps) {
  const scheme = useColorScheme();
  const dark   = scheme === 'dark';

  let source: any;
  let ratio: number;
  let defaultH: number;

  switch (variant) {
    case 'drawer':
      source   = dark ? ASSETS.drawer_d : ASSETS.drawer_l;
      ratio    = RATIOS.drawer;
      defaultH = 48;
      break;
    case 'monogram':
      source   = dark ? ASSETS.mono_d : ASSETS.mono_l;
      ratio    = RATIOS.monogram;
      defaultH = 44;
      break;
    case 'icon':
      source   = ASSETS.icon;
      ratio    = RATIOS.icon;
      defaultH = 80;
      break;
    case 'splash':
      source   = ASSETS.splash;
      ratio    = RATIOS.splash;
      defaultH = 240;
      break;
    case 'light':
      source   = ASSETS.light;
      ratio    = RATIOS.logo;
      defaultH = 56;
      break;
    case 'dark':
      source   = ASSETS.dark;
      ratio    = RATIOS.logo;
      defaultH = 56;
      break;
    case 'auto':
    default:
      source   = dark ? ASSETS.dark : ASSETS.light;
      ratio    = RATIOS.logo;
      defaultH = 56;
      break;
  }

  const h = size ?? defaultH;
  const w = width ?? Math.round(h * ratio);

  return (
    <Image
      source={source}
      style={{ width: w, height: h }}
      contentFit="contain"
      cachePolicy="memory-disk"
      transition={120}
    />
  );
}

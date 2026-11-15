import type { ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useTheme } from '../lib/theme-context';

/**
 * One semantic entry. `name` is typed per family so a mistyped glyph is caught
 * here — the map is the only place a raw vector name appears.
 */
type IconDef =
  | { family: 'ion'; name: ComponentProps<typeof Ionicons>['name'] }
  | { family: 'mci'; name: ComponentProps<typeof MaterialCommunityIcons>['name'] };

/**
 * Semantic icon map. Screens never reference a glyph by its raw vector name —
 * they use these stable semantic keys, so swapping an icon set later is a
 * single edit here instead of a sweep through every screen.
 */
const ICONS = {
  // Actions
  add: { family: 'ion', name: 'add' },
  remove: { family: 'ion', name: 'remove' },
  search: { family: 'ion', name: 'search' },
  close: { family: 'ion', name: 'close' },
  check: { family: 'ion', name: 'checkmark' },
  chevronDown: { family: 'ion', name: 'chevron-down' },
  chevronRight: { family: 'ion', name: 'chevron-forward' },
  chevronLeft: { family: 'ion', name: 'chevron-back' },
  edit: { family: 'ion', name: 'pencil' },
  trash: { family: 'ion', name: 'trash-outline' },
  refresh: { family: 'ion', name: 'refresh' },
  signOut: { family: 'ion', name: 'log-out-outline' },
  camera: { family: 'ion', name: 'camera-outline' },
  copy: { family: 'ion', name: 'copy-outline' },
  more: { family: 'ion', name: 'ellipsis-horizontal' },
  thumbUp: { family: 'ion', name: 'thumbs-up-outline' },
  thumbDown: { family: 'ion', name: 'thumbs-down-outline' },
  feedback: { family: 'ion', name: 'chatbubble-ellipses-outline' },
  scan: { family: 'mci', name: 'barcode-scan' },
  barcode: { family: 'mci', name: 'barcode' },
  print: { family: 'ion', name: 'print-outline' },
  share: { family: 'ion', name: 'share-outline' },
  // Visibility
  eye: { family: 'ion', name: 'eye-outline' },
  eyeOff: { family: 'ion', name: 'eye-off-outline' },
  // Movement
  stockIn: { family: 'ion', name: 'arrow-down-circle-outline' },
  stockOut: { family: 'ion', name: 'arrow-up-circle-outline' },
  adjust: { family: 'ion', name: 'swap-vertical' },
  transfer: { family: 'ion', name: 'swap-horizontal' },
  // Theme
  sunny: { family: 'ion', name: 'sunny-outline' },
  moon: { family: 'ion', name: 'moon-outline' },
  // Status
  checkCircle: { family: 'ion', name: 'checkmark-circle' },
  checkCircleOutline: { family: 'ion', name: 'checkmark-circle-outline' },
  info: { family: 'ion', name: 'information-circle-outline' },
  alert: { family: 'ion', name: 'alert-circle-outline' },
  warning: { family: 'ion', name: 'warning-outline' },
  // Entities / navigation
  cube: { family: 'ion', name: 'cube-outline' },
  people: { family: 'ion', name: 'people-outline' },
  person: { family: 'ion', name: 'person-outline' },
  document: { family: 'ion', name: 'document-text-outline' },
  time: { family: 'ion', name: 'time-outline' },
  lock: { family: 'ion', name: 'lock-closed-outline' },
  receipt: { family: 'mci', name: 'file-document-outline' },
  layers: { family: 'ion', name: 'layers-outline' },
  location: { family: 'ion', name: 'location-outline' },
  pricetags: { family: 'ion', name: 'pricetags-outline' },
  settings: { family: 'ion', name: 'settings-outline' },
  sparkles: { family: 'ion', name: 'sparkles-outline' },
  storefront: { family: 'ion', name: 'storefront-outline' },
} satisfies Record<string, IconDef>;

/** Every semantic key in the map. */
export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<ComponentProps<typeof Ionicons>, 'name' | 'size' | 'color'> {
  name: IconName;
  size?: number;
  color?: string;
}

/**
 * Renders a vector icon from the semantic map. Defaults its color to the
 * active theme's primary text color; camera overlays and other surfaces that
 * must stay fixed pass an explicit `color`.
 */
export function Icon({ name, size = 20, color, ...props }: IconProps) {
  const { colors } = useTheme();
  const def: IconDef | undefined = ICONS[name];
  if (!def) {
    return null;
  }
  const tint = color ?? colors.text;
  // Branching on the family (rather than indexing FAMILIES) is what lets each
  // icon set check its own glyph name.
  if (def.family === 'mci') {
    return <MaterialCommunityIcons name={def.name} size={size} color={tint} {...props} />;
  }
  return <Ionicons name={def.name} size={size} color={tint} {...props} />;
}

export const iconNames: IconName[] = Object.keys(ICONS) as IconName[];
export default Icon;

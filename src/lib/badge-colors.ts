// Curated badge colour palette. A badge value stores one of these keys (not a raw
// hex) so the calendar stays visually consistent — the frontend maps each key to a
// Mantine colour. Keep this list in sync with the FE palette.

export const BADGE_COLORS = [
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "orange",
  "red",
  "pink",
  "grape",
  "violet",
  "gray",
] as const;

export type BadgeColor = (typeof BADGE_COLORS)[number];

export const isBadgeColor = (c: string): c is BadgeColor =>
  (BADGE_COLORS as readonly string[]).includes(c);

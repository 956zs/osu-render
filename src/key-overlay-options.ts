/** Corners the keyboard overlay can sit in (render option keyOverlayCorner). */
export const KEY_OVERLAY_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type KeyOverlayCorner = typeof KEY_OVERLAY_CORNERS[number];

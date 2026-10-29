import { appConfig, type EncoderFamily } from './app-config.js';

export const SUPPORTED_ENCODERS = [
  'h264_nvenc', 'hevc_nvenc', 'h264_amf', 'hevc_amf', 'h264_qsv', 'hevc_qsv', 'libx264',
] as const;

export type VideoEncoder = typeof SUPPORTED_ENCODERS[number];
export type EncoderSetting = VideoEncoder | 'unknown';
export type EncoderVendor = 'nvidia' | 'amd' | 'intel' | 'cpu' | 'none';
export type EncoderKind = 'hardware' | 'software' | 'none';

const VENDORS: Readonly<Record<VideoEncoder, EncoderVendor>> = {
  h264_nvenc: 'nvidia', hevc_nvenc: 'nvidia', h264_amf: 'amd', hevc_amf: 'amd',
  h264_qsv: 'intel', hevc_qsv: 'intel', libx264: 'cpu',
};

const FAMILIES: Readonly<Record<VideoEncoder, EncoderFamily>> = {
  h264_nvenc: 'nvenc', hevc_nvenc: 'nvenc', h264_amf: 'amf', hevc_amf: 'amf',
  h264_qsv: 'qsv', hevc_qsv: 'qsv', libx264: 'x264',
};

/** Speed profile table (appConfig.speedProfiles.families) an encoder uses. */
export function encoderFamily(encoder: VideoEncoder): EncoderFamily {
  return FAMILIES[encoder];
}

export function isHevcEncoder(encoder: VideoEncoder): boolean {
  return encoder.startsWith('hevc_');
}

export function isSupportedEncoder(value: string): value is VideoEncoder {
  return (SUPPORTED_ENCODERS as readonly string[]).includes(value);
}

export function encoderVendor(encoder: EncoderSetting): EncoderVendor {
  return encoder === 'unknown' ? 'none' : VENDORS[encoder];
}

export function isHardwareEncoder(encoder: EncoderSetting): boolean {
  const vendor = encoderVendor(encoder);
  return vendor !== 'cpu' && vendor !== 'none';
}

export function encoderKind(encoder: EncoderSetting): EncoderKind {
  if (encoder === 'unknown') return 'none';
  return isHardwareEncoder(encoder) ? 'hardware' : 'software';
}

export function isAutoEncoder(override: string): boolean {
  return override.trim().toLowerCase() === 'auto';
}

export function encoderCandidates(
  override: string,
  platform: NodeJS.Platform = process.platform,
  autoOrder: Readonly<Record<string, readonly string[]>> = appConfig.encoders.autoOrder,
): VideoEncoder[] {
  const value = override.trim().toLowerCase();
  if (value === 'auto') return [...new Set(validOrder(autoOrder, autoOrder[platform] ? platform : 'default'))];
  if (!isSupportedEncoder(value)) {
    throw new Error(`RENDER_ENCODER must be "auto" or one of ${SUPPORTED_ENCODERS.join(', ')} (got "${override}").`);
  }
  return [...new Set<VideoEncoder>([value, 'libx264'])];
}

function validOrder(autoOrder: Readonly<Record<string, readonly string[]>>, key: string): VideoEncoder[] {
  return (autoOrder[key] ?? []).map((encoder, index) => {
    if (!isSupportedEncoder(encoder)) {
      throw new Error(`Invalid app config: encoders.autoOrder.${key}[${index}] "${encoder}" is not a supported encoder.`);
    }
    return encoder;
  });
}

for (const key of Object.keys(appConfig.encoders.autoOrder)) validOrder(appConfig.encoders.autoOrder, key);

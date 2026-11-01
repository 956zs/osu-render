// Example osu-render plugin (API 1): a coloured frame around the video. See docs/plugins.md.
import path from 'node:path';

const COLORS = { white: '0xffffff', pink: '0xff66aa', black: '0x000000' };

// No external tool needed: always available.
export function available() {
  return true;
}

export async function videoStage(ctx) {
  const color = COLORS[ctx.options.color] ?? COLORS.pink;
  const thickness = Math.round(ctx.options.thickness);
  const output = path.join(ctx.workDir, 'border.mp4');
  // The host re-encodes with the job's encoder settings (libx264 fallback) and copies the audio.
  const { encoder } = await ctx.utils.encodeVideo({
    filter: `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=${thickness}[v]`,
    output,
  });
  ctx.log(`frame drawn with ${encoder}`);
  return { status: 'applied', output, note: `${ctx.options.color} frame, ${thickness} px` };
}

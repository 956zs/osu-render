import { AppError } from './errors.js';
import type { BeatmapMetadata } from './types.js';

const TOKEN_SAFETY_MS = 60_000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface LookupResponse {
  id: number;
  beatmapset_id: number;
  checksum?: string;
  total_length?: number;
  version?: string;
  beatmapset?: { artist?: string; title?: string; creator?: string };
}

export interface OsuApiConfig {
  clientId: string;
  clientSecret: string;
}

export class OsuApiClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: OsuApiConfig) {}

  async lookupBeatmap(checksum: string): Promise<BeatmapMetadata> {
    const token = await this.getToken();
    const url = new URL('https://osu.ppy.sh/api/v2/beatmaps/lookup');
    url.searchParams.set('checksum', checksum);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) throw new AppError('BEATMAP_NOT_FOUND', 'Beatmap was not found.', 404);
    if (!response.ok) throw new AppError('BEATMAP_NOT_FOUND', `osu! API returned HTTP ${response.status}.`, 502);
    const data = await response.json() as LookupResponse;
    return {
      id: data.id,
      beatmapsetId: data.beatmapset_id,
      checksum: data.checksum,
      totalLength: data.total_length,
      version: data.version,
      artist: data.beatmapset?.artist,
      title: data.beatmapset?.title,
      creator: data.beatmapset?.creator,
    };
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SAFETY_MS) return this.token;
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new AppError('RENDERER_UNAVAILABLE', 'osu! OAuth credentials are not configured.', 503);
    }
    const response = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: Number(this.config.clientId),
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
    });
    if (!response.ok) throw new AppError('RENDERER_UNAVAILABLE', 'osu! OAuth authentication failed.', 503);
    const data = await response.json() as TokenResponse;
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }
}

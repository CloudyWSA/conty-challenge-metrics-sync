export const platforms = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = typeof platforms[number];

export type Connection = {
  id: string;
  platform: Platform;
  account_id: string;
  access_token: string;
  created_at: string;
};

export type SyncWindow = { from: string; to: string };

export type PostSnapshot = {
  post_id: string;
  published_at: string;
  captured_at: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

export interface Provider {
  fetchPosts(connection: Connection, window: SyncWindow, signal: AbortSignal): Promise<PostSnapshot[]>;
}

export class ProviderError extends Error {
  constructor(public status: number, public retryAfter?: string) {
    super(`provider returned ${status}`);
  }
}

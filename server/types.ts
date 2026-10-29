import type { WebSocket } from 'ws';

export type AppRole = 'individual' | 'organization' | 'admin';

export type AuthUser = {
  id: number;
  publicId: string;
  username: string;
  email: string;
  displayName: string;
  role: AppRole;
  permissions: string[];
};

export interface GameRoom {
  id: string;
  dbId: number | null;
  hostUserId: number;
  pinHash: string;
  hostToken: string;
  hostSocket: WebSocket | null;
  displays: Set<WebSocket>;
  latestState: any;
  stageConfig: {
    layout?: Record<string, unknown>;
    background?: string | null;
    controlsHidden?: boolean;
  };
  openedAt: number;
  lastActive: number;
  hostDisconnectedAt: number | null;
  // PostgreSQL writes must stay ordered. Production latency can otherwise
  // make an older snapshot overwrite a newer one while the room is live.
  persistenceTail: Promise<void>;
}

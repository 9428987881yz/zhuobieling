export type GameType = "undercover" | "gomoku" | "ludo";

export type RoomPhase = "lobby" | "playing" | "ended";

export type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
};

export type Player = {
  id: string;
  name: string;
  userId?: string;
  avatarUrl?: string;
  color: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
};

export type GameMeta = {
  type: GameType;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  shortDescription: string;
};

export const GAME_META: Record<GameType, GameMeta> = {
  undercover: {
    type: "undercover",
    name: "谁是卧底",
    minPlayers: 3,
    maxPlayers: 8,
    shortDescription: "拿到词语后轮流描述，投票找出卧底。"
  },
  gomoku: {
    type: "gomoku",
    name: "五子棋",
    minPlayers: 2,
    maxPlayers: 2,
    shortDescription: "黑白双方轮流落子，先连成五子获胜。"
  },
  ludo: {
    type: "ludo",
    name: "飞行棋简版",
    minPlayers: 2,
    maxPlayers: 4,
    shortDescription: "轮流掷骰前进，率先抵达终点。"
  }
};

export type UndercoverStage = "speaking" | "voting" | "ended";

export type UndercoverPublicState = {
  type: "undercover";
  stage: UndercoverStage;
  round: number;
  currentSpeakerId?: string;
  spokenCount: number;
  myWord?: string;
  myRole?: "civilian" | "undercover";
  eliminatedIds: string[];
  votes: Record<string, string>;
  lastEliminatedId?: string;
  winnerTeam?: "civilian" | "undercover";
  winnerIds?: string[];
  reason?: string;
  revealedRoles?: Record<string, "civilian" | "undercover">;
};

export type GomokuStone = "black" | "white";

export type GomokuPublicState = {
  type: "gomoku";
  size: number;
  board: (GomokuStone | null)[][];
  currentPlayerId?: string;
  playerStones: Record<string, GomokuStone>;
  winnerId?: string;
  winningLine?: Array<[number, number]>;
  isDraw?: boolean;
  moves: number;
};

export type LudoPublicState = {
  type: "ludo";
  finish: number;
  positions: Record<string, number>;
  currentPlayerId?: string;
  lastRoll?: {
    playerId: string;
    value: number;
  };
  winnerId?: string;
  turnCount: number;
};

export type PublicGameState =
  | UndercoverPublicState
  | GomokuPublicState
  | LudoPublicState;

export type RoomView = {
  code: string;
  phase: RoomPhase;
  selectedGame: GameType;
  hostId: string;
  players: Player[];
  chat: ChatMessage[];
  gameState: PublicGameState | null;
  createdAt: number;
};

export type AuthProfile = {
  userId?: string;
  name: string;
  avatarUrl?: string;
};

export type CreateRoomPayload = {
  playerId: string;
  playerName: string;
  gameType: GameType;
  profile?: AuthProfile;
};

export type JoinRoomPayload = {
  code: string;
  playerId: string;
  playerName: string;
  profile?: AuthProfile;
};

export type RoomReadyPayload = {
  ready: boolean;
};

export type SelectGamePayload = {
  gameType: GameType;
};

export type ChatPayload = {
  text: string;
};

export type GameActionPayload =
  | { type: "undercover:next-speaker" }
  | { type: "undercover:vote"; targetId: string }
  | { type: "gomoku:place"; x: number; y: number }
  | { type: "ludo:roll" };

export type GameType = "undercover" | "gomoku" | "ludo" | "catan";

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

export const AVATAR_PRESET_IDS = [
  "zero",
  "star",
  "road",
  "city",
  "dice",
  "word",
  "flag",
  "island",
  "circle",
  "strategy",
  "ember",
  "wave",
  "mountain",
  "forest",
  "stone",
  "crown"
] as const;

export type AvatarPresetId = (typeof AVATAR_PRESET_IDS)[number];
export type AvatarPresetValue = `preset:${AvatarPresetId}`;

export type AvatarPreset = {
  id: AvatarPresetId;
  value: AvatarPresetValue;
  name: string;
  mark: string;
  primary: string;
  secondary: string;
};

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: "zero", value: "preset:zero", name: "零号圆桌", mark: "零", primary: "#063047", secondary: "#ff5542" },
  { id: "star", value: "preset:star", name: "星点玩家", mark: "星", primary: "#1d4ed8", secondary: "#f59e0b" },
  { id: "road", value: "preset:road", name: "开路先锋", mark: "路", primary: "#0f766e", secondary: "#84cc16" },
  { id: "city", value: "preset:city", name: "筑城者", mark: "城", primary: "#7c2d12", secondary: "#fb923c" },
  { id: "dice", value: "preset:dice", name: "骰点好运", mark: "骰", primary: "#312e81", secondary: "#38bdf8" },
  { id: "word", value: "preset:word", name: "词语大师", mark: "词", primary: "#111827", secondary: "#facc15" },
  { id: "flag", value: "preset:flag", name: "胜利旗手", mark: "旗", primary: "#be123c", secondary: "#fb7185" },
  { id: "island", value: "preset:island", name: "海岛旅人", mark: "岛", primary: "#0369a1", secondary: "#2dd4bf" },
  { id: "circle", value: "preset:circle", name: "圆桌同盟", mark: "圆", primary: "#334155", secondary: "#94a3b8" },
  { id: "strategy", value: "preset:strategy", name: "策略家", mark: "策", primary: "#365314", secondary: "#bef264" },
  { id: "ember", value: "preset:ember", name: "炽热回合", mark: "火", primary: "#991b1b", secondary: "#f97316" },
  { id: "wave", value: "preset:wave", name: "清流布局", mark: "水", primary: "#155e75", secondary: "#67e8f9" },
  { id: "mountain", value: "preset:mountain", name: "稳山落子", mark: "山", primary: "#3f3f46", secondary: "#a3e635" },
  { id: "forest", value: "preset:forest", name: "林间计划", mark: "林", primary: "#14532d", secondary: "#22c55e" },
  { id: "stone", value: "preset:stone", name: "坚石守位", mark: "石", primary: "#475569", secondary: "#cbd5e1" },
  { id: "crown", value: "preset:crown", name: "冠军席位", mark: "冠", primary: "#713f12", secondary: "#fbbf24" }
];

export function isAvatarPresetValue(value: unknown): value is AvatarPresetValue {
  return (
    typeof value === "string" &&
    AVATAR_PRESETS.some((preset) => preset.value === value)
  );
}

export function getAvatarPreset(value: unknown) {
  return AVATAR_PRESETS.find((preset) => preset.value === value);
}

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
  },
  catan: {
    type: "catan",
    name: "卡坦岛",
    minPlayers: 3,
    maxPlayers: 4,
    shortDescription: "采集资源、修路建村，先到 10 分获胜。"
  }
};

export type UndercoverStage = "speaking" | "voting" | "ended";

export type SkipVoteChoice = "yes" | "no";

export type SkipVoteState = {
  targetPlayerId: string;
  eligiblePlayerIds: string[];
  votes: Record<string, SkipVoteChoice>;
  createdAt: number;
};

export type UndercoverPublicState = {
  type: "undercover";
  stage: UndercoverStage;
  round: number;
  currentSpeakerId?: string;
  turnDurationMs: number;
  turnEndsAt?: number;
  skipVote?: SkipVoteState;
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
  turnDurationMs: number;
  turnEndsAt?: number;
  skipVote?: SkipVoteState;
  playerStones: Record<string, GomokuStone>;
  winnerId?: string;
  winningLine?: Array<[number, number]>;
  isDraw?: boolean;
  timeoutLoserId?: string;
  resultReason?: string;
  moves: number;
};

export type LudoPublicState = {
  type: "ludo";
  finish: number;
  positions: Record<string, number>;
  currentPlayerId?: string;
  turnDurationMs: number;
  turnEndsAt?: number;
  skipVote?: SkipVoteState;
  lastRoll?: {
    playerId: string;
    value: number;
  };
  winnerId?: string;
  timeoutLoserId?: string;
  resultReason?: string;
  turnCount: number;
};

export type CatanResource = "wood" | "brick" | "sheep" | "wheat" | "ore";

export type CatanTerrain =
  | "forest"
  | "hill"
  | "pasture"
  | "field"
  | "mountain"
  | "desert";

export type CatanBuildingKind = "settlement" | "city";

export type CatanHex = {
  id: string;
  q: number;
  r: number;
  x: number;
  y: number;
  terrain: CatanTerrain;
  resource?: CatanResource;
  number?: number;
};

export type CatanVertex = {
  id: string;
  x: number;
  y: number;
  adjacentHexIds: string[];
  building?: {
    playerId: string;
    kind: CatanBuildingKind;
  };
};

export type CatanEdge = {
  id: string;
  vertexIds: [string, string];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  roadOwnerId?: string;
};

export type CatanPlayerState = {
  resources: Record<CatanResource, number>;
  roads: number;
  settlements: number;
  cities: number;
  victoryPoints: number;
};

export type CatanSetupPhase = "settlement" | "road";

export type CatanPublicState = {
  type: "catan";
  phase: "setup" | "playing" | "ended";
  hexes: CatanHex[];
  vertices: CatanVertex[];
  edges: CatanEdge[];
  currentPlayerId?: string;
  turnDurationMs: number;
  turnEndsAt?: number;
  skipVote?: SkipVoteState;
  setupPhase?: CatanSetupPhase;
  setupRound?: 1 | 2;
  setupOrder?: string[];
  setupIndex?: number;
  pendingSettlementVertexId?: string;
  hasRolled: boolean;
  needsRobberMove: boolean;
  robberHexId: string;
  lastRoll?: {
    dice: [number, number];
    total: number;
  };
  playerStates: Record<string, CatanPlayerState>;
  winnerId?: string;
  resultReason?: string;
};

export type PublicGameState =
  | UndercoverPublicState
  | GomokuPublicState
  | LudoPublicState
  | CatanPublicState;

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
  authToken?: string;
};

export type JoinRoomPayload = {
  code: string;
  playerId: string;
  playerName: string;
  profile?: AuthProfile;
  authToken?: string;
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
  | { type: "ludo:roll" }
  | { type: "catan:place-settlement"; vertexId: string }
  | { type: "catan:place-road"; edgeId: string }
  | { type: "catan:upgrade-city"; vertexId: string }
  | { type: "catan:roll" }
  | { type: "catan:move-robber"; hexId: string }
  | { type: "catan:bank-trade"; give: CatanResource; receive: CatanResource }
  | { type: "catan:end-turn" }
  | { type: "skip:vote"; vote: SkipVoteChoice };

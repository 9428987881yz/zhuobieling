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

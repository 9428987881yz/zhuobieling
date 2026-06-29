import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Server, Socket } from "socket.io";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  AuthProfile,
  ChatMessage,
  ChatPayload,
  CreateRoomPayload,
  GAME_META,
  GameActionPayload,
  GameType,
  GomokuPublicState,
  GomokuStone,
  JoinRoomPayload,
  LudoPublicState,
  Player,
  PublicGameState,
  RoomReadyPayload,
  RoomView,
  SelectGamePayload,
  UndercoverPublicState
} from "../shared/types.js";

type InternalPlayer = Player & {
  socketId?: string;
};

type UndercoverAssignment = {
  role: "civilian" | "undercover";
  word: string;
};

type UndercoverInternalState = Omit<
  UndercoverPublicState,
  "myWord" | "myRole"
> & {
  assignments: Record<string, UndercoverAssignment>;
  order: string[];
  speakerCursor: number;
};

type LudoInternalState = LudoPublicState & {
  order: string[];
  turnIndex: number;
};

type InternalGameState =
  | UndercoverInternalState
  | GomokuPublicState
  | LudoInternalState;

type Room = {
  code: string;
  phase: "lobby" | "playing" | "ended";
  selectedGame: GameType;
  hostId: string;
  players: InternalPlayer[];
  chat: ChatMessage[];
  gameState: InternalGameState | null;
  createdAt: number;
};

type SocketWithData = Socket & {
  data: {
    roomCode?: string;
    playerId?: string;
  };
};

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 3001);
const origins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim())
  : true;

app.use(cors({ origin: origins, credentials: true }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: origins,
    credentials: true
  }
});

const supabase = createSupabaseClient();
const rooms = new Map<string, Room>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

const palette = [
  "#0ea5a4",
  "#f97316",
  "#64748b",
  "#e11d48",
  "#2563eb",
  "#16a34a",
  "#ca8a04",
  "#9333ea"
];

const undercoverWordPairs = [
  ["牛奶", "豆浆"],
  ["火锅", "麻辣烫"],
  ["月亮", "星星"],
  ["咖啡", "奶茶"],
  ["公交车", "地铁"],
  ["篮球", "足球"],
  ["老师", "教练"],
  ["苹果", "梨"],
  ["电影", "电视剧"],
  ["雨伞", "帽子"]
] as const;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    supabase: Boolean(supabase)
  });
});

const distPath = path.resolve(process.cwd(), "dist");
app.use(express.static(distPath));
app.get("*", (_req, res) => {
  const indexPath = path.join(distPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }

  res.status(404).send("前端还没有构建。开发时请同时运行 Vite 客户端。");
});

io.on("connection", (socket: SocketWithData) => {
  socket.on("room:create", (payload: CreateRoomPayload) => {
    const playerId = normalizePlayerId(payload.playerId);
    const playerName = normalizePlayerName(
      payload.profile?.name || payload.playerName
    );
    const gameType = isGameType(payload.gameType)
      ? payload.gameType
      : "undercover";
    const code = generateRoomCode();
    const player = createPlayer(playerId, playerName, payload.profile, true, 0);
    player.socketId = socket.id;

    const room: Room = {
      code,
      phase: "lobby",
      selectedGame: gameType,
      hostId: player.id,
      players: [player],
      chat: [],
      gameState: null,
      createdAt: Date.now()
    };

    rooms.set(code, room);
    joinSocketRoom(socket, room, player);
    void snapshotRoom(room);
    socket.emit("room:joined", roomViewFor(room, player.id));
    emitRoom(room);
  });

  socket.on("room:join", (payload: JoinRoomPayload) => {
    const code = normalizeRoomCode(payload.code);
    const room = rooms.get(code);
    if (!room) {
      socket.emit("error:message", "没有找到这个房间号。");
      return;
    }

    const playerId = normalizePlayerId(payload.playerId);
    const playerName = normalizePlayerName(
      payload.profile?.name || payload.playerName
    );
    const existing = room.players.find((player) => player.id === playerId);
    const meta = GAME_META[room.selectedGame];

    if (!existing && room.phase !== "lobby") {
      socket.emit("error:message", "游戏已经开始，新玩家暂时不能加入。");
      return;
    }

    if (!existing && room.players.length >= meta.maxPlayers) {
      socket.emit("error:message", `${meta.name} 最多 ${meta.maxPlayers} 人。`);
      return;
    }

    const player =
      existing ||
      createPlayer(
        playerId,
        playerName,
        payload.profile,
        false,
        room.players.length
      );

    player.name = playerName;
    player.userId = payload.profile?.userId;
    player.avatarUrl = payload.profile?.avatarUrl;
    player.connected = true;
    player.socketId = socket.id;

    if (!existing) {
      room.players.push(player);
    }

    joinSocketRoom(socket, room, player);
    cancelCleanup(room.code);
    void snapshotRoom(room);
    socket.emit("room:joined", roomViewFor(room, player.id));
    emitSystemMessage(room, `${player.name} 加入了房间`);
    emitRoom(room);
  });

  socket.on("room:ready", (payload: RoomReadyPayload) => {
    const context = getSocketContext(socket);
    if (!context || context.room.phase !== "lobby") return;
    context.player.ready = Boolean(payload.ready);
    emitRoom(context.room);
  });

  socket.on("room:selectGame", (payload: SelectGamePayload) => {
    const context = getSocketContext(socket);
    if (!context || context.room.phase !== "lobby") return;
    if (context.player.id !== context.room.hostId) {
      socket.emit("error:message", "只有房主可以切换游戏。");
      return;
    }

    if (!isGameType(payload.gameType)) {
      socket.emit("error:message", "暂不支持这个游戏。");
      return;
    }

    context.room.selectedGame = payload.gameType;
    context.room.players.forEach((player) => {
      player.ready = false;
    });
    emitSystemMessage(
      context.room,
      `房主切换到了 ${GAME_META[payload.gameType].name}`
    );
    void snapshotRoom(context.room);
    emitRoom(context.room);
  });

  socket.on("room:start", () => {
    const context = getSocketContext(socket);
    if (!context || context.room.phase !== "lobby") return;
    if (context.player.id !== context.room.hostId) {
      socket.emit("error:message", "只有房主可以开始游戏。");
      return;
    }

    const validation = validateStart(context.room);
    if (!validation.ok) {
      socket.emit("error:message", validation.message);
      return;
    }

    context.room.phase = "playing";
    context.room.gameState = createInitialGameState(context.room);
    context.room.players.forEach((player) => {
      player.ready = false;
    });
    emitSystemMessage(
      context.room,
      `${GAME_META[context.room.selectedGame].name} 开始了`
    );
    void snapshotRoom(context.room);
    emitRoom(context.room);
  });

  socket.on("room:restart", () => {
    const context = getSocketContext(socket);
    if (!context) return;
    if (context.player.id !== context.room.hostId) {
      socket.emit("error:message", "只有房主可以重开房间。");
      return;
    }

    context.room.phase = "lobby";
    context.room.gameState = null;
    context.room.players.forEach((player) => {
      player.ready = false;
    });
    emitSystemMessage(context.room, "房间已回到等待区");
    void snapshotRoom(context.room);
    emitRoom(context.room);
  });

  socket.on("chat:send", (payload: ChatPayload) => {
    const context = getSocketContext(socket);
    if (!context) return;
    const text = String(payload.text || "").trim().slice(0, 200);
    if (!text) return;
    context.room.chat.push({
      id: createId(),
      playerId: context.player.id,
      playerName: context.player.name,
      text,
      createdAt: Date.now()
    });
    trimChat(context.room);
    emitRoom(context.room);
  });

  socket.on("game:action", (payload: GameActionPayload) => {
    const context = getSocketContext(socket);
    if (!context || context.room.phase !== "playing" || !context.room.gameState) {
      return;
    }

    const error = applyGameAction(context.room, context.player, payload);
    if (error) {
      socket.emit("error:message", error);
      return;
    }

    void snapshotRoom(context.room);
    emitRoom(context.room);
  });

  socket.on("room:leave", () => {
    leaveCurrentRoom(socket, true);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket, false);
  });
});

server.listen(port, () => {
  console.log(`桌别零 server listening on http://localhost:${port}`);
});

function createSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false
    }
  });
}

function createPlayer(
  id: string,
  name: string,
  profile: AuthProfile | undefined,
  isHost: boolean,
  index: number
): InternalPlayer {
  return {
    id,
    name,
    userId: profile?.userId,
    avatarUrl: profile?.avatarUrl,
    color: palette[index % palette.length],
    ready: false,
    connected: true,
    isHost
  };
}

function joinSocketRoom(
  socket: SocketWithData,
  room: Room,
  player: InternalPlayer
) {
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  void socket.join(room.code);
}

function getSocketContext(socket: SocketWithData) {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!roomCode || !playerId) return null;
  const room = rooms.get(roomCode);
  if (!room) return null;
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) return null;
  return { room, player };
}

function leaveCurrentRoom(socket: SocketWithData, explicit: boolean) {
  const context = getSocketContext(socket);
  if (!context) return;
  const { room, player } = context;

  if (player.socketId === socket.id) {
    player.socketId = undefined;
    player.connected = false;
    player.ready = false;
  }

  if (explicit && room.phase === "lobby") {
    room.players = room.players.filter((entry) => entry.id !== player.id);
    void socket.leave(room.code);
    socket.emit("room:cleared");
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === player.id || !room.players.some((entry) => entry.isHost)) {
    const nextHost = room.players.find((entry) => entry.connected) || room.players[0];
    room.hostId = nextHost.id;
    room.players.forEach((entry) => {
      entry.isHost = entry.id === nextHost.id;
    });
  }

  emitRoom(room);
  scheduleCleanup(room);
}

function validateStart(room: Room): { ok: true } | { ok: false; message: string } {
  const meta = GAME_META[room.selectedGame];
  const connectedPlayers = room.players.filter((player) => player.connected);
  if (connectedPlayers.length < meta.minPlayers) {
    return { ok: false, message: `${meta.name} 至少需要 ${meta.minPlayers} 人。` };
  }

  if (connectedPlayers.length > meta.maxPlayers) {
    return { ok: false, message: `${meta.name} 最多支持 ${meta.maxPlayers} 人。` };
  }

  const notReady = connectedPlayers.filter(
    (player) => player.id !== room.hostId && !player.ready
  );
  if (notReady.length > 0) {
    return { ok: false, message: "还有玩家没有准备。 " };
  }

  room.players = connectedPlayers;
  return { ok: true };
}

function createInitialGameState(room: Room): InternalGameState {
  if (room.selectedGame === "undercover") return createUndercoverState(room);
  if (room.selectedGame === "gomoku") return createGomokuState(room);
  return createLudoState(room);
}

function createUndercoverState(room: Room): UndercoverInternalState {
  const order = shuffle(room.players.map((player) => player.id));
  const pair = undercoverWordPairs[randomInt(undercoverWordPairs.length)];
  const undercoverWordIndex = randomInt(2);
  const undercoverWord = pair[undercoverWordIndex];
  const civilianWord = pair[undercoverWordIndex === 0 ? 1 : 0];
  const undercoverId = order[randomInt(order.length)];
  const assignments: Record<string, UndercoverAssignment> = {};

  order.forEach((playerId) => {
    const isUndercover = playerId === undercoverId;
    assignments[playerId] = {
      role: isUndercover ? "undercover" : "civilian",
      word: isUndercover ? undercoverWord : civilianWord
    };
  });

  return {
    type: "undercover",
    stage: "speaking",
    round: 1,
    currentSpeakerId: order[0],
    spokenCount: 0,
    eliminatedIds: [],
    votes: {},
    assignments,
    order,
    speakerCursor: 0
  };
}

function createGomokuState(room: Room): GomokuPublicState {
  const size = 15;
  const playerStones: Record<string, GomokuStone> = {};
  room.players.slice(0, 2).forEach((player, index) => {
    playerStones[player.id] = index === 0 ? "black" : "white";
  });

  return {
    type: "gomoku",
    size,
    board: Array.from({ length: size }, () => Array<GomokuStone | null>(size).fill(null)),
    currentPlayerId: room.players[0]?.id,
    playerStones,
    moves: 0
  };
}

function createLudoState(room: Room): LudoInternalState {
  const order = shuffle(room.players.map((player) => player.id));
  return {
    type: "ludo",
    finish: 30,
    positions: Object.fromEntries(order.map((playerId) => [playerId, 0])),
    currentPlayerId: order[0],
    turnCount: 1,
    order,
    turnIndex: 0
  };
}

function applyGameAction(
  room: Room,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  const state = room.gameState;
  if (!state) return "游戏还没有开始。";

  if (state.type === "undercover") {
    return applyUndercoverAction(room, state, player, payload);
  }

  if (state.type === "gomoku") {
    return applyGomokuAction(room, state, player, payload);
  }

  return applyLudoAction(room, state, player, payload);
}

function applyUndercoverAction(
  room: Room,
  state: UndercoverInternalState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  const activeIds = getActiveUndercoverIds(state);
  if (state.stage === "ended") return "本局已经结束。";

  if (payload.type === "undercover:next-speaker") {
    if (
      player.id !== room.hostId &&
      player.id !== state.currentSpeakerId
    ) {
      return "只有当前发言玩家或房主可以切到下一位。";
    }

    const nextSpokenCount = state.spokenCount + 1;
    if (nextSpokenCount >= activeIds.length) {
      state.stage = "voting";
      state.currentSpeakerId = undefined;
      state.spokenCount = activeIds.length;
      state.votes = {};
      return null;
    }

    state.spokenCount = nextSpokenCount;
    state.speakerCursor = nextActiveSpeakerCursor(state);
    state.currentSpeakerId = state.order[state.speakerCursor];
    return null;
  }

  if (payload.type === "undercover:vote") {
    if (state.stage !== "voting") return "现在还没有进入投票。";
    if (!activeIds.includes(player.id)) return "出局玩家不能投票。";
    if (!activeIds.includes(payload.targetId)) return "只能投给仍在场的玩家。";

    state.votes[player.id] = payload.targetId;
    if (Object.keys(state.votes).length >= activeIds.length) {
      resolveUndercoverVote(room, state);
    }
    return null;
  }

  return "这个操作不属于谁是卧底。";
}

function resolveUndercoverVote(room: Room, state: UndercoverInternalState) {
  const tally = new Map<string, number>();
  Object.values(state.votes).forEach((targetId) => {
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  });

  let topVotes = 0;
  let topTargets: string[] = [];
  tally.forEach((votes, targetId) => {
    if (votes > topVotes) {
      topVotes = votes;
      topTargets = [targetId];
    } else if (votes === topVotes) {
      topTargets.push(targetId);
    }
  });

  if (topTargets.length !== 1) {
    state.round += 1;
    state.stage = "speaking";
    state.spokenCount = 0;
    state.votes = {};
    state.lastEliminatedId = undefined;
    state.reason = "平票，本轮无人出局。";
    state.speakerCursor = firstActiveSpeakerCursor(state);
    state.currentSpeakerId = state.order[state.speakerCursor];
    return;
  }

  const eliminatedId = topTargets[0];
  state.eliminatedIds.push(eliminatedId);
  state.lastEliminatedId = eliminatedId;
  const eliminatedRole = state.assignments[eliminatedId]?.role;
  const activeAfter = getActiveUndercoverIds(state);
  const undercoverId = Object.entries(state.assignments).find(
    ([, assignment]) => assignment.role === "undercover"
  )?.[0];

  if (eliminatedRole === "undercover") {
    endUndercoverGame(room, state, "civilian", "卧底被投出，平民胜利。");
    return;
  }

  if (undercoverId && activeAfter.includes(undercoverId) && activeAfter.length <= 2) {
    endUndercoverGame(room, state, "undercover", "场上只剩两人，卧底胜利。");
    return;
  }

  state.round += 1;
  state.stage = "speaking";
  state.spokenCount = 0;
  state.votes = {};
  state.reason = "投票完成，进入下一轮发言。";
  state.speakerCursor = firstActiveSpeakerCursor(state);
  state.currentSpeakerId = state.order[state.speakerCursor];
}

function endUndercoverGame(
  room: Room,
  state: UndercoverInternalState,
  winnerTeam: "civilian" | "undercover",
  reason: string
) {
  state.stage = "ended";
  state.currentSpeakerId = undefined;
  state.winnerTeam = winnerTeam;
  state.reason = reason;
  state.winnerIds = Object.entries(state.assignments)
    .filter(([, assignment]) => assignment.role === winnerTeam)
    .map(([playerId]) => playerId);
  state.revealedRoles = Object.fromEntries(
    Object.entries(state.assignments).map(([playerId, assignment]) => [
      playerId,
      assignment.role
    ])
  );
  room.phase = "ended";
  void recordGameResult(room, state.winnerIds);
}

function applyGomokuAction(
  room: Room,
  state: GomokuPublicState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  if (payload.type !== "gomoku:place") return "这个操作不属于五子棋。";
  if (state.winnerId || state.isDraw) return "本局已经结束。";
  if (player.id !== state.currentPlayerId) return "还没轮到你。";
  if (!Number.isInteger(payload.x) || !Number.isInteger(payload.y)) {
    return "落子位置无效。";
  }

  const { x, y } = payload;
  if (x < 0 || y < 0 || x >= state.size || y >= state.size) {
    return "落子位置超出棋盘。";
  }

  if (state.board[y][x]) return "这里已经有棋子了。";
  const stone = state.playerStones[player.id];
  if (!stone) return "你不是本局五子棋玩家。";

  state.board[y][x] = stone;
  state.moves += 1;
  const winningLine = findWinningLine(state.board, x, y, stone);
  if (winningLine) {
    state.winnerId = player.id;
    state.winningLine = winningLine;
    state.currentPlayerId = undefined;
    room.phase = "ended";
    void recordGameResult(room, [player.id]);
    return null;
  }

  if (state.moves >= state.size * state.size) {
    state.isDraw = true;
    state.currentPlayerId = undefined;
    room.phase = "ended";
    void recordGameResult(room, [], true);
    return null;
  }

  const nextPlayer = room.players.find(
    (entry) => entry.id !== player.id && state.playerStones[entry.id]
  );
  state.currentPlayerId = nextPlayer?.id;
  return null;
}

function applyLudoAction(
  room: Room,
  state: LudoInternalState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  if (payload.type !== "ludo:roll") return "这个操作不属于飞行棋。";
  if (state.winnerId) return "本局已经结束。";
  if (state.currentPlayerId !== player.id) return "还没轮到你。";

  const value = randomInt(6) + 1;
  state.lastRoll = { playerId: player.id, value };
  state.positions[player.id] = Math.min(
    state.finish,
    (state.positions[player.id] || 0) + value
  );

  if (state.positions[player.id] >= state.finish) {
    state.winnerId = player.id;
    state.currentPlayerId = undefined;
    room.phase = "ended";
    void recordGameResult(room, [player.id]);
    return null;
  }

  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.currentPlayerId = state.order[state.turnIndex];
  state.turnCount += 1;
  return null;
}

function roomViewFor(room: Room, viewerId: string): RoomView {
  return {
    code: room.code,
    phase: room.phase,
    selectedGame: room.selectedGame,
    hostId: room.hostId,
    players: room.players.map(publicPlayer),
    chat: room.chat,
    gameState: publicGameState(room.gameState, viewerId),
    createdAt: room.createdAt
  };
}

function publicPlayer(player: InternalPlayer): Player {
  const { socketId: _socketId, ...publicShape } = player;
  return publicShape;
}

function publicGameState(
  state: InternalGameState | null,
  viewerId: string
): PublicGameState | null {
  if (!state) return null;

  if (state.type === "undercover") {
    const assignment = state.assignments[viewerId];
    const {
      assignments: _assignments,
      order: _order,
      speakerCursor: _speakerCursor,
      ...publicState
    } = state;

    return {
      ...publicState,
      myWord: assignment?.word,
      myRole: state.stage === "ended" ? assignment?.role : undefined
    };
  }

  if (state.type === "ludo") {
    const { order: _order, turnIndex: _turnIndex, ...publicState } = state;
    return publicState;
  }

  return state;
}

function emitRoom(room: Room) {
  room.players.forEach((player) => {
    if (player.socketId) {
      io.to(player.socketId).emit("room:state", roomViewFor(room, player.id));
    }
  });
}

function emitSystemMessage(room: Room, text: string) {
  room.chat.push({
    id: createId(),
    playerId: "system",
    playerName: "系统",
    text,
    createdAt: Date.now()
  });
  trimChat(room);
}

function trimChat(room: Room) {
  if (room.chat.length > 80) {
    room.chat = room.chat.slice(room.chat.length - 80);
  }
}

async function recordGameResult(
  room: Room,
  winnerIds: string[],
  draw = false
) {
  if (!supabase) return;

  const rows = room.players
    .filter((player) => player.userId)
    .map((player) => ({
      room_code: room.code,
      game_type: room.selectedGame,
      user_id: player.userId,
      player_name: player.name,
      result: draw ? "draw" : winnerIds.includes(player.id) ? "win" : "loss"
    }));

  if (rows.length === 0) return;
  const { error } = await supabase.from("game_records").insert(rows);
  if (error) {
    console.warn("Failed to persist game records:", error.message);
  }
}

async function snapshotRoom(room: Room) {
  if (!supabase) return;

  const { error } = await supabase.from("rooms_snapshot").upsert({
    room_code: room.code,
    game_type: room.selectedGame,
    phase: room.phase,
    player_count: room.players.length,
    updated_at: new Date().toISOString()
  });

  if (error) {
    console.warn("Failed to snapshot room:", error.message);
  }
}

function findWinningLine(
  board: (GomokuStone | null)[][],
  x: number,
  y: number,
  stone: GomokuStone
): Array<[number, number]> | null {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ] as const;

  for (const [dx, dy] of directions) {
    const line: Array<[number, number]> = [[x, y]];

    for (const direction of [-1, 1]) {
      let nextX = x + dx * direction;
      let nextY = y + dy * direction;
      while (board[nextY]?.[nextX] === stone) {
        line.push([nextX, nextY]);
        nextX += dx * direction;
        nextY += dy * direction;
      }
    }

    if (line.length >= 5) {
      return line.sort(([ax, ay], [bx, by]) => ay - by || ax - bx);
    }
  }

  return null;
}

function getActiveUndercoverIds(state: UndercoverInternalState) {
  return state.order.filter((playerId) => !state.eliminatedIds.includes(playerId));
}

function firstActiveSpeakerCursor(state: UndercoverInternalState) {
  const index = state.order.findIndex(
    (playerId) => !state.eliminatedIds.includes(playerId)
  );
  return Math.max(index, 0);
}

function nextActiveSpeakerCursor(state: UndercoverInternalState) {
  for (let step = 1; step <= state.order.length; step += 1) {
    const index = (state.speakerCursor + step) % state.order.length;
    if (!state.eliminatedIds.includes(state.order[index])) {
      return index;
    }
  }
  return state.speakerCursor;
}

function scheduleCleanup(room: Room) {
  if (room.players.some((player) => player.connected)) return;
  cancelCleanup(room.code);
  cleanupTimers.set(
    room.code,
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (current && current.players.every((player) => !player.connected)) {
        rooms.delete(room.code);
      }
      cleanupTimers.delete(room.code);
    }, 5 * 60 * 1000)
  );
}

function cancelCleanup(roomCode: string) {
  const timer = cleanupTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  cleanupTimers.delete(roomCode);
}

function generateRoomCode() {
  let code = "";
  do {
    code = Array.from({ length: 6 }, () =>
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(32)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function normalizeRoomCode(value: string) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function normalizePlayerId(value: string) {
  return String(value || createId()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function normalizePlayerName(value: string) {
  const name = String(value || "").trim().slice(0, 18);
  return name || `玩家${randomInt(900) + 100}`;
}

function isGameType(value: string): value is GameType {
  return value === "undercover" || value === "gomoku" || value === "ludo";
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function randomInt(max: number) {
  return Math.floor(Math.random() * max);
}

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

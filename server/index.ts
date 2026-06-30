import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Server, Socket } from "socket.io";
import { createClient, SupabaseClient, type User } from "@supabase/supabase-js";
import {
  AuthProfile,
  CatanEdge,
  CatanHex,
  CatanPlayerState,
  CatanPublicState,
  CatanResource,
  CatanTerrain,
  CatanVertex,
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
  SkipVoteChoice,
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

type CatanInternalState = CatanPublicState;

type InternalGameState =
  | UndercoverInternalState
  | GomokuPublicState
  | LudoInternalState
  | CatanInternalState;

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
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: origins,
    credentials: true
  }
});

const supabase = createSupabaseClient();
const supabaseAuth = createSupabaseAuthClient();
const rooms = new Map<string, Room>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();
const gameStepTimers = new Map<string, NodeJS.Timeout>();
const GAME_STEP_MS = 2 * 60 * 1000;
const MAX_DAILY_LOGIN_FAILURES = 6;
const LOGIN_LOCK_TIME_ZONE = process.env.LOGIN_LOCK_TIME_ZONE || "Asia/Shanghai";
const fallbackLoginAttempts = new Map<
  string,
  { dayKey: string; failedCount: number; lockedUntilMs: number }
>();

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

const catanTerrainBag: CatanTerrain[] = [
  "forest",
  "forest",
  "forest",
  "forest",
  "pasture",
  "pasture",
  "pasture",
  "pasture",
  "field",
  "field",
  "field",
  "field",
  "hill",
  "hill",
  "hill",
  "mountain",
  "mountain",
  "mountain",
  "desert"
];

const catanNumberTokens = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

const catanTerrainResource: Partial<Record<CatanTerrain, CatanResource>> = {
  forest: "wood",
  hill: "brick",
  pasture: "sheep",
  field: "wheat",
  mountain: "ore"
};

const catanBuildCosts: Record<"road" | "settlement" | "city", Partial<Record<CatanResource, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 }
};

const catanResources: CatanResource[] = ["wood", "brick", "sheep", "wheat", "ore"];

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    supabase: Boolean(supabase),
    supabaseAuth: Boolean(supabaseAuth)
  });
});

app.post("/api/auth/login", async (req, res) => {
  if (!supabase || !supabaseAuth) {
    res.status(503).json({ error: "账号系统还没配置完成，请稍后再试。" });
    return;
  }

  const email = normalizeLoginEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || password.length < 6) {
    res.status(400).json({ error: "请输入邮箱，密码至少 6 位。" });
    return;
  }

  const now = new Date();
  const dayKey = getLoginDayKey(now);
  const lockedUntil = getNextLoginDayStart(now);
  const emailHash = hashLoginEmail(email);
  const attempt = await readLoginAttempt(emailHash, dayKey);

  if (
    attempt.lockedUntilMs > now.getTime() ||
    attempt.failedCount >= MAX_DAILY_LOGIN_FAILURES
  ) {
    const lockMs =
      attempt.lockedUntilMs > now.getTime()
        ? attempt.lockedUntilMs
        : lockedUntil.getTime();
    await saveLoginAttempt(emailHash, dayKey, MAX_DAILY_LOGIN_FAILURES, lockMs);
    res.status(423).json({
      error: "密码已输错 6 次，今天不能再登录，请明天再试。",
      remainingAttempts: 0,
      lockedUntil: new Date(lockMs).toISOString()
    });
    return;
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    if (isInvalidLoginError(error)) {
      const nextFailedCount = Math.min(
        MAX_DAILY_LOGIN_FAILURES,
        attempt.failedCount + 1
      );
      const lockMs =
        nextFailedCount >= MAX_DAILY_LOGIN_FAILURES ? lockedUntil.getTime() : 0;
      await saveLoginAttempt(emailHash, dayKey, nextFailedCount, lockMs);
      const remainingAttempts = Math.max(
        0,
        MAX_DAILY_LOGIN_FAILURES - nextFailedCount
      );

      res.status(remainingAttempts === 0 ? 423 : 401).json({
        error:
          remainingAttempts === 0
            ? "密码已输错 6 次，今天不能再登录，请明天再试。"
            : `邮箱或密码不正确，今天还可以再试 ${remainingAttempts} 次。`,
        remainingAttempts,
        lockedUntil:
          remainingAttempts === 0 ? new Date(lockMs).toISOString() : undefined
      });
      return;
    }

    res.status(401).json({ error: error.message });
    return;
  }

  if (!data.session || !data.user) {
    res.status(401).json({ error: "登录失败，请重新输入账号密码。" });
    return;
  }

  await clearLoginAttempt(emailHash, dayKey);
  res.json({
    session: data.session,
    user: data.user
  });
});

app.get("/api/profile", async (req, res) => {
  if (!supabase) {
    res.status(503).json({ error: "账号系统还没配置完成，请稍后再试。" });
    return;
  }

  const auth = await getAuthenticatedRequestUser(req.headers.authorization);
  if ("error" in auth) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  type ProfileRow = {
    display_name?: string | null;
    avatar_url?: string | null;
    honor_text?: string | null;
  };

  let honorColumnReady = true;
  const profileResult = await supabase
    .from("profiles")
    .select("display_name, avatar_url, honor_text")
    .eq("id", auth.user.id)
    .maybeSingle();
  let data = profileResult.data as ProfileRow | null;
  let error: unknown = profileResult.error;

  if (error && isMissingHonorTextColumn(error)) {
    honorColumnReady = false;
    const fallback = await supabase
      .from("profiles")
      .select("display_name, avatar_url")
      .eq("id", auth.user.id)
      .maybeSingle();
    data = fallback.data as ProfileRow | null;
    error = fallback.error;
  }

  if (error) {
    res.status(500).json({ error: "读取个人资料失败，请检查 Supabase 配置。" });
    return;
  }

  const displayName = normalizePlayerName(
    data?.display_name || getDefaultProfileName(auth.user)
  );

  if (!data) {
    const baseProfile = {
      id: auth.user.id,
      display_name: displayName,
      avatar_url: null,
      honor_text: "",
      updated_at: new Date().toISOString()
    };
    const { error: insertError } = await supabase
      .from("profiles")
      .upsert(honorColumnReady ? baseProfile : withoutHonorText(baseProfile));

    if (insertError) {
      res.status(500).json({ error: "创建个人资料失败，请检查 Supabase 配置。" });
      return;
    }
  }

  const storedHonorText =
    data && "honor_text" in data && typeof data.honor_text === "string"
      ? data.honor_text
      : "";

  res.json({
    displayName,
    avatarUrl: data?.avatar_url || null,
    honorText: storedHonorText
  });
});

app.put("/api/profile", async (req, res) => {
  if (!supabase) {
    res.status(503).json({ error: "账号系统还没配置完成，请稍后再试。" });
    return;
  }

  const auth = await getAuthenticatedRequestUser(req.headers.authorization);
  if ("error" in auth) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const displayName = normalizePlayerName(req.body?.displayName);
  const avatarUrl = normalizeProfileAvatarUrl(req.body?.avatarUrl);
  const honorText = normalizeProfileText(req.body?.honorText, 180);
  const baseProfile = {
    id: auth.user.id,
    display_name: displayName,
    avatar_url: avatarUrl,
    honor_text: honorText,
    updated_at: new Date().toISOString()
  };
  let savedHonorText = honorText;
  let { error } = await supabase.from("profiles").upsert(baseProfile);

  if (error && isMissingHonorTextColumn(error)) {
    savedHonorText = "";
    const fallback = await supabase.from("profiles").upsert(withoutHonorText(baseProfile));
    error = fallback.error;
  }

  if (error) {
    res.status(500).json({ error: "保存个人资料失败。" });
    return;
  }

  res.json({ displayName, avatarUrl, honorText: savedHonorText });
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
  socket.on("room:create", async (payload: CreateRoomPayload) => {
    const authProfile = await requireRegisteredProfile(socket, payload);
    if (!authProfile) return;

    const playerId = normalizePlayerId(payload.playerId);
    const playerName = normalizePlayerName(
      authProfile.name || payload.playerName
    );
    const gameType = isGameType(payload.gameType)
      ? payload.gameType
      : "undercover";
    const code = generateRoomCode();
    const player = createPlayer(playerId, playerName, authProfile, true, 0);
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

  socket.on("room:join", async (payload: JoinRoomPayload) => {
    const authProfile = await requireRegisteredProfile(socket, payload);
    if (!authProfile) return;

    const code = normalizeRoomCode(payload.code);
    const room = rooms.get(code);
    if (!room) {
      socket.emit("error:message", "没有找到这个房间号。");
      return;
    }

    const playerId = normalizePlayerId(payload.playerId);
    const playerName = normalizePlayerName(
      authProfile.name || payload.playerName
    );
    const existing = room.players.find((player) => player.id === playerId);
    const meta = GAME_META[room.selectedGame];

    if (existing && existing.userId !== authProfile.userId) {
      socket.emit("error:message", "这个房间身份已经属于其他账号，请重新登录后再试。");
      return;
    }

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
        authProfile,
        false,
        room.players.length
      );

    player.name = playerName;
    player.userId = authProfile.userId;
    player.avatarUrl = authProfile.avatarUrl;
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
    scheduleGameStepTimer(context.room);
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
    clearGameStepTimer(context.room.code);
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

    scheduleGameStepTimer(context.room);
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

function createSupabaseAuthClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function normalizeLoginEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hashLoginEmail(email: string) {
  return createHash("sha256").update(email).digest("hex");
}

function getLoginDayKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOGIN_LOCK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function getNextLoginDayStart(now: Date) {
  const currentDay = getLoginDayKey(now);
  let probe = new Date(now.getTime() + 60 * 60 * 1000);
  for (let index = 0; index < 48 && getLoginDayKey(probe) === currentDay; index += 1) {
    probe = new Date(probe.getTime() + 60 * 60 * 1000);
  }

  let low = now.getTime();
  let high = probe.getTime();
  for (let index = 0; index < 40; index += 1) {
    const middle = Math.floor((low + high) / 2);
    if (getLoginDayKey(new Date(middle)) === currentDay) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return new Date(high);
}

function isInvalidLoginError(error: { message?: string }) {
  const message = error.message?.toLowerCase() || "";
  return (
    message.includes("invalid login credentials") ||
    message.includes("invalid credentials")
  );
}

async function getAuthenticatedRequestUser(
  authorization: string | undefined
): Promise<{ user: User } | { status: number; error: string }> {
  if (!supabase) {
    return { status: 503, error: "账号系统还没配置完成，请稍后再试。" };
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { status: 401, error: "请先登录账号。" };
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return { status: 401, error: "登录已失效，请重新登录。" };
  }

  return { user: data.user };
}

function getDefaultProfileName(user: User) {
  const metadataName =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name
      : "";
  return metadataName || user.email?.split("@")[0] || "新玩家";
}

function normalizeProfileText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeProfileAvatarUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > 700_000) return null;
  if (
    clean.startsWith("data:image/png;base64,") ||
    clean.startsWith("data:image/jpeg;base64,") ||
    clean.startsWith("data:image/webp;base64,") ||
    clean.startsWith("https://") ||
    clean.startsWith("http://")
  ) {
    return clean;
  }
  return null;
}

function withoutHonorText<T extends { honor_text?: unknown }>(profile: T) {
  const { honor_text: _honorText, ...rest } = profile;
  return rest;
}

function isMissingHonorTextColumn(error: unknown) {
  const known = error as { code?: string; details?: string; message?: string };
  return (
    known?.code === "42703" ||
    known?.message?.includes("honor_text") ||
    known?.details?.includes("honor_text")
  );
}

async function readLoginAttempt(emailHash: string, dayKey: string) {
  const memoryAttempt = fallbackLoginAttempts.get(`${emailHash}:${dayKey}`);
  let failedCount = memoryAttempt?.failedCount || 0;
  let lockedUntilMs = memoryAttempt?.lockedUntilMs || 0;

  if (supabase) {
    const { data, error } = await supabase
      .from("auth_login_attempts")
      .select("failed_count, locked_until")
      .eq("email_hash", emailHash)
      .eq("attempt_day", dayKey)
      .maybeSingle();

    if (!error && data) {
      failedCount = Math.max(failedCount, Number(data.failed_count) || 0);
      lockedUntilMs = Math.max(
        lockedUntilMs,
        data.locked_until ? Date.parse(String(data.locked_until)) || 0 : 0
      );
    }
  }

  return { failedCount, lockedUntilMs };
}

async function saveLoginAttempt(
  emailHash: string,
  dayKey: string,
  failedCount: number,
  lockedUntilMs: number
) {
  const key = `${emailHash}:${dayKey}`;
  fallbackLoginAttempts.set(key, { dayKey, failedCount, lockedUntilMs });

  if (!supabase) return;
  await supabase.from("auth_login_attempts").upsert({
    email_hash: emailHash,
    attempt_day: dayKey,
    failed_count: failedCount,
    locked_until: lockedUntilMs ? new Date(lockedUntilMs).toISOString() : null,
    updated_at: new Date().toISOString()
  });
}

async function clearLoginAttempt(emailHash: string, dayKey: string) {
  fallbackLoginAttempts.delete(`${emailHash}:${dayKey}`);
  if (!supabase) return;
  await supabase
    .from("auth_login_attempts")
    .delete()
    .eq("email_hash", emailHash)
    .eq("attempt_day", dayKey);
}

async function requireRegisteredProfile(
  socket: SocketWithData,
  payload: CreateRoomPayload | JoinRoomPayload
): Promise<(AuthProfile & { userId: string }) | null> {
  if (!supabase) {
    socket.emit(
      "error:message",
      "当前服务还没有配置账号系统，暂时不能进入房间。请先配置 Supabase。"
    );
    return null;
  }

  const authToken = payload.authToken?.trim();
  if (!authToken) {
    socket.emit("error:message", "请先注册或登录账号后再进入房间。");
    return null;
  }

  const { data, error } = await supabase.auth.getUser(authToken);
  const user = data.user;
  if (error || !user) {
    socket.emit("error:message", "登录已失效，请重新登录后再进入房间。");
    return null;
  }

  if (payload.profile?.userId && payload.profile.userId !== user.id) {
    socket.emit("error:message", "账号身份不一致，请重新登录后再试。");
    return null;
  }

  const metadataName =
    typeof user.user_metadata?.display_name === "string"
      ? user.user_metadata.display_name
      : "";
  const emailName = user.email?.split("@")[0] || "";
  return {
    userId: user.id,
    name: normalizePlayerName(payload.profile?.name || metadataName || emailName),
    avatarUrl: payload.profile?.avatarUrl
  };
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
    clearGameStepTimer(room.code);
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
  if (room.selectedGame === "ludo") return createLudoState(room);
  return createCatanState(room);
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
    turnDurationMs: GAME_STEP_MS,
    turnEndsAt: Date.now() + GAME_STEP_MS,
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
    turnDurationMs: GAME_STEP_MS,
    turnEndsAt: Date.now() + GAME_STEP_MS,
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
    turnDurationMs: GAME_STEP_MS,
    turnEndsAt: Date.now() + GAME_STEP_MS,
    turnCount: 1,
    order,
    turnIndex: 0
  };
}

function createCatanState(room: Room): CatanInternalState {
  const { hexes, vertices, edges } = createCatanBoard();
  const setupOrder = [
    ...room.players.map((player) => player.id),
    ...room.players.map((player) => player.id).reverse()
  ];
  const playerStates = Object.fromEntries(
    room.players.map((player) => [player.id, createCatanPlayerState()])
  );
  const robberHex = hexes.find((hex) => hex.terrain === "desert") || hexes[0];

  return {
    type: "catan",
    phase: "setup",
    hexes,
    vertices,
    edges,
    currentPlayerId: setupOrder[0],
    turnDurationMs: GAME_STEP_MS,
    turnEndsAt: Date.now() + GAME_STEP_MS,
    setupPhase: "settlement",
    setupRound: 1,
    setupOrder,
    setupIndex: 0,
    hasRolled: false,
    needsRobberMove: false,
    robberHexId: robberHex.id,
    playerStates
  };
}

function createCatanPlayerState(): CatanPlayerState {
  return {
    resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
    roads: 0,
    settlements: 0,
    cities: 0,
    victoryPoints: 0
  };
}

function createCatanBoard() {
  const coords: Array<[number, number]> = [];
  for (let r = -2; r <= 2; r += 1) {
    for (let q = -2; q <= 2; q += 1) {
      if (Math.abs(q + r) <= 2) coords.push([q, r]);
    }
  }

  const terrainBag = shuffle([...catanTerrainBag]);
  const tokenQueue = [...catanNumberTokens];
  const hexes: CatanHex[] = coords.map(([q, r], index) => {
    const terrain = terrainBag[index];
    const resource = catanTerrainResource[terrain];
    const center = catanHexCenter(q, r);
    return {
      id: `h${index}`,
      q,
      r,
      x: center.x,
      y: center.y,
      terrain,
      resource,
      number: terrain === "desert" ? undefined : tokenQueue.shift()
    };
  });

  const vertexMap = new Map<string, CatanVertex>();
  const edgeMap = new Map<string, CatanEdge>();
  hexes.forEach((hex) => {
    const corners = catanCorners(hex.x, hex.y);
    const vertexIds = corners.map((corner) => {
      const key = coordKey(corner.x, corner.y);
      const existing = vertexMap.get(key);
      if (existing) {
        existing.adjacentHexIds.push(hex.id);
        return existing.id;
      }

      const vertex: CatanVertex = {
        id: `v${vertexMap.size}`,
        x: roundCoord(corner.x),
        y: roundCoord(corner.y),
        adjacentHexIds: [hex.id]
      };
      vertexMap.set(key, vertex);
      return vertex.id;
    });

    for (let index = 0; index < 6; index += 1) {
      const a = vertexIds[index];
      const b = vertexIds[(index + 1) % 6];
      const edgeKey = [a, b].sort().join("-");
      if (!edgeMap.has(edgeKey)) {
        const v1 = Array.from(vertexMap.values()).find((vertex) => vertex.id === a)!;
        const v2 = Array.from(vertexMap.values()).find((vertex) => vertex.id === b)!;
        edgeMap.set(edgeKey, {
          id: `e${edgeMap.size}`,
          vertexIds: [a, b],
          x1: v1.x,
          y1: v1.y,
          x2: v2.x,
          y2: v2.y
        });
      }
    }
  });

  return {
    hexes,
    vertices: Array.from(vertexMap.values()),
    edges: Array.from(edgeMap.values())
  };
}

function catanHexCenter(q: number, r: number) {
  return {
    x: roundCoord(Math.sqrt(3) * (q + r / 2)),
    y: roundCoord(1.5 * r)
  };
}

function catanCorners(x: number, y: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (30 + 60 * index);
    return {
      x: x + Math.cos(angle),
      y: y + Math.sin(angle)
    };
  });
}

function roundCoord(value: number) {
  return Math.round(value * 1000) / 1000;
}

function coordKey(x: number, y: number) {
  return `${roundCoord(x)}:${roundCoord(y)}`;
}

function applyGameAction(
  room: Room,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  const state = room.gameState;
  if (!state) return "游戏还没有开始。";

  if (payload.type === "skip:vote") {
    return applySkipVote(room, state, player, payload.vote);
  }

  if (state.skipVote) {
    return "正在投票是否跳过当前玩家。";
  }

  if (state.type === "undercover") {
    return applyUndercoverAction(room, state, player, payload);
  }

  if (state.type === "gomoku") {
    return applyGomokuAction(room, state, player, payload);
  }

  if (state.type === "ludo") {
    return applyLudoAction(room, state, player, payload);
  }

  return applyCatanAction(room, state, player, payload);
}

function applySkipVote(
  room: Room,
  state: InternalGameState,
  player: InternalPlayer,
  vote: SkipVoteChoice
): string | null {
  const skipVote = state.skipVote;
  if (!skipVote) return "现在没有需要处理的跳过投票。";
  if (!skipVote.eligiblePlayerIds.includes(player.id)) {
    return "你不在本次跳过投票中。";
  }

  skipVote.votes[player.id] = vote;
  if (vote === "no") {
    resumeTimedOutPlayer(room, state, `${player.name} 不同意跳过，当前玩家继续获得 2 分钟。`);
    return null;
  }

  const allAgreed = skipVote.eligiblePlayerIds.every(
    (playerId) => skipVote.votes[playerId] === "yes"
  );
  if (allAgreed) {
    skipTimedOutPlayer(room, state, skipVote.targetPlayerId);
  }

  return null;
}

function startSkipVote(
  room: Room,
  state: InternalGameState,
  targetPlayerId: string | undefined,
  eligiblePlayerIds: string[],
  message: string
) {
  if (!targetPlayerId || state.skipVote) return;
  const connectedEligibleIds = eligiblePlayerIds.filter((playerId) =>
    room.players.some((player) => player.id === playerId && player.connected)
  );

  state.turnEndsAt = undefined;
  state.skipVote = {
    targetPlayerId,
    eligiblePlayerIds: connectedEligibleIds,
    votes: {},
    createdAt: Date.now()
  };
  setStepMessage(state, message);

  if (connectedEligibleIds.length === 0) {
    skipTimedOutPlayer(room, state, targetPlayerId);
  }
}

function resumeTimedOutPlayer(
  _room: Room,
  state: InternalGameState,
  message: string
) {
  state.skipVote = undefined;
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
  setStepMessage(state, message);
}

function skipTimedOutPlayer(
  room: Room,
  state: InternalGameState,
  targetPlayerId: string
) {
  const target = room.players.find((player) => player.id === targetPlayerId);
  const targetName = target?.name || "当前玩家";

  if (state.type === "undercover") {
    skipUndercoverSpeaker(room, state, `大家同意跳过 ${targetName}，进入下一步。`);
    return;
  }

  if (state.type === "gomoku") {
    skipGomokuTurn(room, state, targetPlayerId, `大家同意跳过 ${targetName} 的本手。`);
    return;
  }

  if (state.type === "catan") {
    skipCatanTurn(room, state, targetPlayerId);
    return;
  }

  skipLudoTurn(state, targetPlayerId, `大家同意跳过 ${targetName} 的本步。`);
}

function setStepMessage(state: InternalGameState, message: string) {
  if (state.type === "undercover") {
    state.reason = message;
    return;
  }

  state.resultReason = message;
}

function applyUndercoverAction(
  room: Room,
  state: UndercoverInternalState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  const activeIds = getActiveUndercoverIds(state);
  if (state.stage === "ended") return "本局已经结束。";
  if (isUndercoverStepExpired(state)) {
    resolveUndercoverTimeout(room, state);
    return null;
  }

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
      state.turnEndsAt = Date.now() + GAME_STEP_MS;
      return null;
    }

    state.spokenCount = nextSpokenCount;
    state.speakerCursor = nextActiveSpeakerCursor(state);
    state.currentSpeakerId = state.order[state.speakerCursor];
    state.turnEndsAt = Date.now() + GAME_STEP_MS;
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

function isUndercoverStepExpired(state: UndercoverInternalState) {
  return Boolean(
    state.stage !== "ended" &&
      state.turnEndsAt &&
      Date.now() >= state.turnEndsAt
  );
}

function resolveUndercoverTimeout(room: Room, state: UndercoverInternalState) {
  if (state.stage === "ended") return;
  const now = Date.now();

  if (state.stage === "speaking") {
    const activeIds = getActiveUndercoverIds(state);
    const speaker = room.players.find(
      (player) => player.id === state.currentSpeakerId
    );
    startSkipVote(
      room,
      state,
      state.currentSpeakerId,
      activeIds.filter((playerId) => playerId !== state.currentSpeakerId),
      `${speaker?.name || "当前玩家"} 发言超过 2 分钟，请大家投票是否跳过。`
    );
    return;
  }

  if (Object.keys(state.votes).length > 0) {
    state.reason = "投票超过 2 分钟，按已投票结果结算。";
    resolveUndercoverVote(room, state);
    return;
  }

  state.round += 1;
  state.stage = "speaking";
  state.spokenCount = 0;
  state.votes = {};
  state.lastEliminatedId = undefined;
  state.reason = "投票超过 2 分钟且无人投票，本轮无人出局。";
  state.speakerCursor = firstActiveSpeakerCursor(state);
  state.currentSpeakerId = state.order[state.speakerCursor];
  state.turnEndsAt = now + GAME_STEP_MS;
}

function skipUndercoverSpeaker(
  _room: Room,
  state: UndercoverInternalState,
  reason: string
) {
  const activeIds = getActiveUndercoverIds(state);
  const nextSpokenCount = state.spokenCount + 1;

  state.skipVote = undefined;
  state.reason = reason;

  if (nextSpokenCount >= activeIds.length) {
    state.stage = "voting";
    state.currentSpeakerId = undefined;
    state.spokenCount = activeIds.length;
    state.votes = {};
    state.turnEndsAt = Date.now() + GAME_STEP_MS;
    return;
  }

  state.spokenCount = nextSpokenCount;
  state.speakerCursor = nextActiveSpeakerCursor(state);
  state.currentSpeakerId = state.order[state.speakerCursor];
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
}

function resolveUndercoverVote(room: Room, state: UndercoverInternalState) {
  state.skipVote = undefined;
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
    state.turnEndsAt = Date.now() + GAME_STEP_MS;
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
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
}

function endUndercoverGame(
  room: Room,
  state: UndercoverInternalState,
  winnerTeam: "civilian" | "undercover",
  reason: string
) {
  state.stage = "ended";
  state.currentSpeakerId = undefined;
  state.turnEndsAt = undefined;
  state.skipVote = undefined;
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
  if (isGomokuTurnExpired(state)) {
    startGomokuSkipVote(room, state);
    return null;
  }
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
  state.skipVote = undefined;
  state.timeoutLoserId = undefined;
  state.resultReason = undefined;
  state.moves += 1;
  const winningLine = findWinningLine(state.board, x, y, stone);
  if (winningLine) {
    state.winnerId = player.id;
    state.winningLine = winningLine;
    state.currentPlayerId = undefined;
    state.turnEndsAt = undefined;
    state.resultReason = "五子连珠，获胜。";
    room.phase = "ended";
    clearGameStepTimer(room.code);
    void recordGameResult(room, [player.id]);
    return null;
  }

  if (state.moves >= state.size * state.size) {
    state.isDraw = true;
    state.currentPlayerId = undefined;
    state.turnEndsAt = undefined;
    state.resultReason = "棋盘已满，平局。";
    room.phase = "ended";
    clearGameStepTimer(room.code);
    void recordGameResult(room, [], true);
    return null;
  }

  const nextPlayer = room.players.find(
    (entry) => entry.id !== player.id && state.playerStones[entry.id]
  );
  state.currentPlayerId = nextPlayer?.id;
  state.turnEndsAt = state.currentPlayerId ? Date.now() + GAME_STEP_MS : undefined;
  return null;
}

function isGomokuTurnExpired(state: GomokuPublicState) {
  return Boolean(
    state.currentPlayerId &&
      state.turnEndsAt &&
      !state.winnerId &&
      !state.isDraw &&
      Date.now() >= state.turnEndsAt
  );
}

function scheduleGameStepTimer(room: Room) {
  clearGameStepTimer(room.code);
  const state = room.gameState;
  if (room.phase !== "playing" || !state || state.skipVote || !state.turnEndsAt) {
    return;
  }

  if (
    state.type === "gomoku" &&
    (!state.currentPlayerId || state.winnerId || state.isDraw)
  ) {
    return;
  }

  if (
    state.type === "undercover" &&
    (state.stage === "ended" || !state.turnEndsAt)
  ) {
    return;
  }

  if (
    state.type === "ludo" &&
    (!state.currentPlayerId || state.winnerId)
  ) {
    return;
  }

  if (
    state.type === "catan" &&
    (!state.currentPlayerId || state.phase === "ended")
  ) {
    return;
  }

  const expectedPlayerId =
    state.type === "undercover" ? state.currentSpeakerId : state.currentPlayerId;
  const expectedStage = state.type === "undercover" ? state.stage : undefined;
  const delay = Math.max(0, state.turnEndsAt - Date.now());
  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    const currentState = currentRoom?.gameState;
    if (!currentRoom || currentRoom.phase !== "playing" || !currentState) {
      return;
    }

    if (currentState.type === "gomoku") {
      if (
        currentState.currentPlayerId !== expectedPlayerId ||
        !isGomokuTurnExpired(currentState)
      ) {
        return;
      }
      startGomokuSkipVote(currentRoom, currentState);
    } else if (currentState.type === "undercover") {
      if (
        currentState.stage !== expectedStage ||
        currentState.currentSpeakerId !== expectedPlayerId ||
        !isUndercoverStepExpired(currentState)
      ) {
        return;
      }
      resolveUndercoverTimeout(currentRoom, currentState);
      scheduleGameStepTimer(currentRoom);
    } else if (currentState.type === "ludo") {
      if (
        currentState.currentPlayerId !== expectedPlayerId ||
        !isLudoTurnExpired(currentState)
      ) {
        return;
      }
      startLudoSkipVote(currentRoom, currentState);
    } else {
      if (
        currentState.currentPlayerId !== expectedPlayerId ||
        !isCatanStepExpired(currentState)
      ) {
        return;
      }
      startCatanSkipVote(currentRoom, currentState);
    }

    void snapshotRoom(currentRoom);
    emitRoom(currentRoom);
  }, delay + 100);

  gameStepTimers.set(room.code, timer);
}

function clearGameStepTimer(roomCode: string) {
  const timer = gameStepTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  gameStepTimers.delete(roomCode);
}

function startGomokuSkipVote(room: Room, state: GomokuPublicState) {
  const target = room.players.find((player) => player.id === state.currentPlayerId);
  startSkipVote(
    room,
    state,
    state.currentPlayerId,
    Object.keys(state.playerStones).filter(
      (playerId) => playerId !== state.currentPlayerId
    ),
    `${target?.name || "当前玩家"} 超过 2 分钟未确认落子，请大家投票是否跳过。`
  );
}

function skipGomokuTurn(
  room: Room,
  state: GomokuPublicState,
  targetPlayerId: string,
  reason: string
) {
  if (state.currentPlayerId !== targetPlayerId || state.winnerId || state.isDraw) {
    return;
  }

  const nextPlayer = room.players.find(
    (entry) => entry.id !== targetPlayerId && state.playerStones[entry.id]
  );
  state.skipVote = undefined;
  state.timeoutLoserId = targetPlayerId;
  state.resultReason = reason;
  state.currentPlayerId = nextPlayer?.id;
  state.turnEndsAt = state.currentPlayerId ? Date.now() + GAME_STEP_MS : undefined;
}

function applyLudoAction(
  room: Room,
  state: LudoInternalState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  if (payload.type !== "ludo:roll") return "这个操作不属于飞行棋。";
  if (state.winnerId) return "本局已经结束。";
  if (isLudoTurnExpired(state)) {
    startLudoSkipVote(room, state);
    return null;
  }
  if (state.currentPlayerId !== player.id) return "还没轮到你。";

  const value = randomInt(6) + 1;
  state.skipVote = undefined;
  state.timeoutLoserId = undefined;
  state.resultReason = undefined;
  state.lastRoll = { playerId: player.id, value };
  state.positions[player.id] = Math.min(
    state.finish,
    (state.positions[player.id] || 0) + value
  );

  if (state.positions[player.id] >= state.finish) {
    state.winnerId = player.id;
    state.currentPlayerId = undefined;
    state.turnEndsAt = undefined;
    state.resultReason = "率先抵达终点，获胜。";
    room.phase = "ended";
    clearGameStepTimer(room.code);
    void recordGameResult(room, [player.id]);
    return null;
  }

  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.currentPlayerId = state.order[state.turnIndex];
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
  state.turnCount += 1;
  return null;
}

function isLudoTurnExpired(state: LudoInternalState) {
  return Boolean(
    state.currentPlayerId &&
      state.turnEndsAt &&
      !state.winnerId &&
      Date.now() >= state.turnEndsAt
  );
}

function startLudoSkipVote(room: Room, state: LudoInternalState) {
  const target = room.players.find((player) => player.id === state.currentPlayerId);
  startSkipVote(
    room,
    state,
    state.currentPlayerId,
    state.order.filter((playerId) => playerId !== state.currentPlayerId),
    `${target?.name || "当前玩家"} 超过 2 分钟未掷骰，请大家投票是否跳过。`
  );
}

function skipLudoTurn(
  state: LudoInternalState,
  targetPlayerId: string,
  reason: string
) {
  if (state.currentPlayerId !== targetPlayerId || state.winnerId) return;

  state.skipVote = undefined;
  state.timeoutLoserId = targetPlayerId;
  state.resultReason = reason;
  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.currentPlayerId = state.order[state.turnIndex];
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
  state.turnCount += 1;
}

function applyCatanAction(
  room: Room,
  state: CatanInternalState,
  player: InternalPlayer,
  payload: GameActionPayload
): string | null {
  if (state.phase === "ended") return "本局已经结束。";
  if (isCatanStepExpired(state)) {
    startCatanSkipVote(room, state);
    return null;
  }
  if (state.currentPlayerId !== player.id) return "还没轮到你。";

  if (state.phase === "setup") {
    if (payload.type === "catan:place-settlement") {
      return placeCatanSetupSettlement(state, player.id, payload.vertexId);
    }

    if (payload.type === "catan:place-road") {
      return placeCatanSetupRoad(state, player.id, payload.edgeId);
    }

    return "开局阶段需要先放村庄，再放道路。";
  }

  if (payload.type === "catan:roll") {
    if (state.hasRolled) return "本回合已经掷过骰子。";
    const dice: [number, number] = [randomInt(6) + 1, randomInt(6) + 1];
    const total = dice[0] + dice[1];
    state.lastRoll = { dice, total };
    state.hasRolled = true;
    if (total === 7) {
      state.needsRobberMove = true;
      state.resultReason = "掷出 7，请把盗贼移动到一个地形块。";
      refreshCatanStep(state);
      return null;
    }

    produceCatanResources(state, total);
    state.resultReason = `掷出 ${total}，相邻村庄和城市获得资源。`;
    refreshCatanStep(state);
    return null;
  }

  if (!state.hasRolled) return "请先掷骰。";

  if (payload.type === "catan:move-robber") {
    if (!state.needsRobberMove) return "现在不需要移动盗贼。";
    if (!state.hexes.some((hex) => hex.id === payload.hexId)) return "地形块不存在。";
    state.robberHexId = payload.hexId;
    state.needsRobberMove = false;
    state.resultReason = "盗贼已经移动，本回合可以继续建造或结束。";
    refreshCatanStep(state);
    return null;
  }

  if (state.needsRobberMove) return "请先移动盗贼。";

  if (payload.type === "catan:place-road") {
    return buildCatanRoad(state, player.id, payload.edgeId, false);
  }

  if (payload.type === "catan:place-settlement") {
    return buildCatanSettlement(room, state, player.id, payload.vertexId, false);
  }

  if (payload.type === "catan:upgrade-city") {
    return upgradeCatanCity(room, state, player.id, payload.vertexId);
  }

  if (payload.type === "catan:bank-trade") {
    return tradeCatanBank(state, player.id, payload.give, payload.receive);
  }

  if (payload.type === "catan:end-turn") {
    advanceCatanTurn(room, state, "进入下一位玩家。");
    return null;
  }

  return "这个操作不属于卡坦岛。";
}

function placeCatanSetupSettlement(
  state: CatanInternalState,
  playerId: string,
  vertexId: string
): string | null {
  if (state.setupPhase !== "settlement") return "请先为这个村庄连接一条道路。";
  const error = validateCatanSettlementPlacement(state, playerId, vertexId, true);
  if (error) return error;

  const vertex = state.vertices.find((entry) => entry.id === vertexId)!;
  vertex.building = { playerId, kind: "settlement" };
  state.pendingSettlementVertexId = vertexId;
  state.setupPhase = "road";
  state.playerStates[playerId].settlements += 1;
  updateCatanVictoryPoints(state);
  state.resultReason = "村庄已放置，请选择相邻道路。";
  refreshCatanStep(state);
  return null;
}

function placeCatanSetupRoad(
  state: CatanInternalState,
  playerId: string,
  edgeId: string
): string | null {
  if (state.setupPhase !== "road" || !state.pendingSettlementVertexId) {
    return "请先放置村庄。";
  }

  const edge = state.edges.find((entry) => entry.id === edgeId);
  if (!edge) return "道路位置不存在。";
  if (edge.roadOwnerId) return "这条边已经有道路。";
  if (!edge.vertexIds.includes(state.pendingSettlementVertexId)) {
    return "开局道路必须连接刚放下的村庄。";
  }

  edge.roadOwnerId = playerId;
  state.playerStates[playerId].roads += 1;
  if (state.setupRound === 2) {
    grantInitialCatanResources(state, playerId, state.pendingSettlementVertexId);
  }

  state.pendingSettlementVertexId = undefined;
  advanceCatanSetup(state);
  return null;
}

function advanceCatanSetup(state: CatanInternalState) {
  state.setupIndex = (state.setupIndex || 0) + 1;
  if (!state.setupOrder || state.setupIndex >= state.setupOrder.length) {
    state.phase = "playing";
    state.setupPhase = undefined;
    state.setupRound = undefined;
    state.setupOrder = undefined;
    state.setupIndex = undefined;
    state.currentPlayerId = Object.keys(state.playerStates)[0];
    state.hasRolled = false;
    state.needsRobberMove = false;
    state.turnEndsAt = Date.now() + GAME_STEP_MS;
    state.resultReason = "开局放置完成，正式回合开始。";
    return;
  }

  const half = state.setupOrder.length / 2;
  state.setupRound = state.setupIndex < half ? 1 : 2;
  state.setupPhase = "settlement";
  state.currentPlayerId = state.setupOrder[state.setupIndex];
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
  state.resultReason = "请下一位玩家放置村庄。";
}

function buildCatanRoad(
  state: CatanInternalState,
  playerId: string,
  edgeId: string,
  free: boolean
): string | null {
  const edge = state.edges.find((entry) => entry.id === edgeId);
  if (!edge) return "道路位置不存在。";
  if (edge.roadOwnerId) return "这条边已经有道路。";
  if (!isCatanRoadConnected(state, playerId, edge)) {
    return "道路必须连接自己的道路或村庄/城市。";
  }
  if (!free && !spendCatanResources(state, playerId, catanBuildCosts.road)) {
    return "资源不足：修路需要木头和砖。";
  }

  edge.roadOwnerId = playerId;
  state.playerStates[playerId].roads += 1;
  state.resultReason = "道路已建成。";
  refreshCatanStep(state);
  return null;
}

function buildCatanSettlement(
  room: Room,
  state: CatanInternalState,
  playerId: string,
  vertexId: string,
  free: boolean
): string | null {
  const error = validateCatanSettlementPlacement(state, playerId, vertexId, free);
  if (error) return error;
  if (!free && !spendCatanResources(state, playerId, catanBuildCosts.settlement)) {
    return "资源不足：建村需要木头、砖、羊毛和小麦。";
  }

  const vertex = state.vertices.find((entry) => entry.id === vertexId)!;
  vertex.building = { playerId, kind: "settlement" };
  state.playerStates[playerId].settlements += 1;
  state.resultReason = "新的村庄已建成。";
  updateCatanVictoryPoints(state);
  checkCatanWinner(room, state, playerId);
  refreshCatanStep(state);
  return null;
}

function upgradeCatanCity(
  room: Room,
  state: CatanInternalState,
  playerId: string,
  vertexId: string
): string | null {
  const vertex = state.vertices.find((entry) => entry.id === vertexId);
  if (!vertex?.building || vertex.building.playerId !== playerId) {
    return "只能升级自己的村庄。";
  }
  if (vertex.building.kind !== "settlement") return "这里已经是城市。";
  if (!spendCatanResources(state, playerId, catanBuildCosts.city)) {
    return "资源不足：升级城市需要 2 小麦和 3 矿石。";
  }

  vertex.building.kind = "city";
  state.playerStates[playerId].settlements -= 1;
  state.playerStates[playerId].cities += 1;
  state.resultReason = "村庄已升级为城市。";
  updateCatanVictoryPoints(state);
  checkCatanWinner(room, state, playerId);
  refreshCatanStep(state);
  return null;
}

function tradeCatanBank(
  state: CatanInternalState,
  playerId: string,
  give: CatanResource,
  receive: CatanResource
): string | null {
  if (give === receive) return "请选择不同的资源。";
  if (!catanResources.includes(give) || !catanResources.includes(receive)) {
    return "资源类型不正确。";
  }
  const playerState = state.playerStates[playerId];
  if (playerState.resources[give] < 4) return "4:1 交换需要交出 4 个同类资源。";

  playerState.resources[give] -= 4;
  playerState.resources[receive] += 1;
  state.resultReason = "银行 4:1 交换完成。";
  refreshCatanStep(state);
  return null;
}

function validateCatanSettlementPlacement(
  state: CatanInternalState,
  playerId: string,
  vertexId: string,
  free: boolean
) {
  const vertex = state.vertices.find((entry) => entry.id === vertexId);
  if (!vertex) return "村庄位置不存在。";
  if (vertex.building) return "这里已经有建筑。";
  if (getAdjacentCatanVertices(state, vertexId).some((entry) => entry.building)) {
    return "村庄之间必须至少隔一个交点。";
  }
  if (!free && !state.edges.some(
    (edge) => edge.roadOwnerId === playerId && edge.vertexIds.includes(vertexId)
  )) {
    return "建村必须连接自己的道路。";
  }
  return null;
}

function isCatanRoadConnected(
  state: CatanInternalState,
  playerId: string,
  edge: CatanEdge
) {
  return edge.vertexIds.some((vertexId) => {
    const vertex = state.vertices.find((entry) => entry.id === vertexId);
    if (vertex?.building?.playerId === playerId) return true;
    return state.edges.some(
      (entry) =>
        entry.id !== edge.id &&
        entry.roadOwnerId === playerId &&
        entry.vertexIds.includes(vertexId)
    );
  });
}

function getAdjacentCatanVertices(state: CatanInternalState, vertexId: string) {
  const adjacentIds = new Set<string>();
  state.edges.forEach((edge) => {
    if (!edge.vertexIds.includes(vertexId)) return;
    edge.vertexIds.forEach((id) => {
      if (id !== vertexId) adjacentIds.add(id);
    });
  });
  return state.vertices.filter((vertex) => adjacentIds.has(vertex.id));
}

function spendCatanResources(
  state: CatanInternalState,
  playerId: string,
  cost: Partial<Record<CatanResource, number>>
) {
  const resources = state.playerStates[playerId].resources;
  const canPay = Object.entries(cost).every(
    ([resource, amount]) => resources[resource as CatanResource] >= (amount || 0)
  );
  if (!canPay) return false;
  Object.entries(cost).forEach(([resource, amount]) => {
    resources[resource as CatanResource] -= amount || 0;
  });
  return true;
}

function produceCatanResources(state: CatanInternalState, roll: number) {
  state.hexes
    .filter((hex) => hex.number === roll && hex.resource && hex.id !== state.robberHexId)
    .forEach((hex) => {
      state.vertices
        .filter((vertex) => vertex.adjacentHexIds.includes(hex.id) && vertex.building)
        .forEach((vertex) => {
          const building = vertex.building!;
          const amount = building.kind === "city" ? 2 : 1;
          state.playerStates[building.playerId].resources[hex.resource!] += amount;
        });
    });
}

function grantInitialCatanResources(
  state: CatanInternalState,
  playerId: string,
  vertexId: string
) {
  const vertex = state.vertices.find((entry) => entry.id === vertexId);
  if (!vertex) return;
  vertex.adjacentHexIds.forEach((hexId) => {
    const hex = state.hexes.find((entry) => entry.id === hexId);
    if (hex?.resource) {
      state.playerStates[playerId].resources[hex.resource] += 1;
    }
  });
}

function updateCatanVictoryPoints(state: CatanInternalState) {
  Object.values(state.playerStates).forEach((playerState) => {
    playerState.victoryPoints = playerState.settlements + playerState.cities * 2;
  });
}

function refreshCatanStep(state: CatanInternalState) {
  if (state.phase !== "ended" && state.currentPlayerId) {
    state.turnEndsAt = Date.now() + GAME_STEP_MS;
  }
}

function checkCatanWinner(room: Room, state: CatanInternalState, playerId: string) {
  if (state.playerStates[playerId].victoryPoints < 10) return;
  state.phase = "ended";
  state.winnerId = playerId;
  state.currentPlayerId = undefined;
  state.turnEndsAt = undefined;
  state.resultReason = "达到 10 分，赢得卡坦岛。";
  room.phase = "ended";
  clearGameStepTimer(room.code);
  void recordGameResult(room, [playerId]);
}

function advanceCatanTurn(
  room: Room,
  state: CatanInternalState,
  reason: string
) {
  const playerIds = room.players.map((player) => player.id);
  const currentIndex = Math.max(0, playerIds.indexOf(state.currentPlayerId || ""));
  state.currentPlayerId = playerIds[(currentIndex + 1) % playerIds.length];
  state.hasRolled = false;
  state.needsRobberMove = false;
  state.skipVote = undefined;
  state.turnEndsAt = Date.now() + GAME_STEP_MS;
  state.resultReason = reason;
}

function isCatanStepExpired(state: CatanInternalState) {
  return Boolean(
    state.currentPlayerId &&
      state.turnEndsAt &&
      state.phase !== "ended" &&
      Date.now() >= state.turnEndsAt
  );
}

function startCatanSkipVote(room: Room, state: CatanInternalState) {
  const target = room.players.find((player) => player.id === state.currentPlayerId);
  startSkipVote(
    room,
    state,
    state.currentPlayerId,
    room.players
      .map((player) => player.id)
      .filter((playerId) => playerId !== state.currentPlayerId),
    `${target?.name || "当前玩家"} 超过 2 分钟未操作，请大家投票是否跳过。`
  );
}

function skipCatanTurn(room: Room, state: CatanInternalState, targetPlayerId: string) {
  if (state.currentPlayerId !== targetPlayerId || state.phase === "ended") return;

  state.pendingSettlementVertexId = undefined;
  state.skipVote = undefined;
  if (state.phase === "setup") {
    advanceCatanSetup(state);
    state.resultReason = "大家同意跳过，进入下一位开局放置。";
    return;
  }

  advanceCatanTurn(room, state, "大家同意跳过，进入下一位玩家。");
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

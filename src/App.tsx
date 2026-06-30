import {
  CSSProperties,
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ArrowLeft,
  Check,
  CircleDot,
  Copy,
  Crown,
  Dice6,
  DoorOpen,
  Eye,
  EyeOff,
  Gamepad2,
  Info,
  KeyRound,
  LogOut,
  Play,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Trophy,
  UserPlus,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { io, Socket } from "socket.io-client";
import type { Session } from "@supabase/supabase-js";
import {
  AVATAR_PRESETS,
  GAME_META,
  CatanPublicState,
  CatanResource,
  CatanTerrain,
  GameType,
  GomokuPublicState,
  LudoPublicState,
  Player,
  PublicGameState,
  RoomView,
  SkipVoteState,
  UndercoverPublicState,
  getAvatarPreset,
  isAvatarPresetValue
} from "../shared/types";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import brandLogoUrl from "./assets/zhuobieling-logo.jpg";

type Notice = {
  tone: "info" | "error" | "success";
  text: string;
};

type GameRecord = {
  id: string;
  game_type: GameType;
  result: "win" | "loss" | "draw";
  player_name: string;
  room_code: string;
  created_at: string;
};

type ProfileResponse = {
  displayName?: string;
  avatarUrl?: string | null;
  honorText?: string;
  error?: string;
};

type AuthCodeResponse = {
  sent?: boolean;
  retryAfterSeconds?: number;
  error?: string;
};

type AccountPanelView = "details" | "security" | null;

type GameCategory = {
  title: string;
  description: string;
  games: GameType[];
};

type GameDetail = {
  category: string;
  intro: string;
  highlights: string[];
};

const gameCategories: GameCategory[] = [
  {
    title: "推理派对",
    description: "适合朋友边聊边判断，节奏轻松，人数越多越热闹。",
    games: ["undercover"]
  },
  {
    title: "棋盘对弈",
    description: "落点清晰、回合确认，适合安静思考和一对一较量。",
    games: ["gomoku"]
  },
  {
    title: "轻量竞速",
    description: "规则简单，掷骰前进，适合快速开一局。",
    games: ["ludo"]
  },
  {
    title: "策略建设",
    description: "采集资源、修路建村，适合喜欢规划和交易的玩家。",
    games: ["catan"]
  }
];

const gameDetails: Record<GameType, GameDetail> = {
  undercover: {
    category: "推理派对",
    intro:
      "每位玩家会拿到一个词语，其中少数人拿到相近但不同的词。大家轮流描述自己的词，不能直接说出答案，最后投票找出卧底。",
    highlights: ["3-8 人开局", "轮流发言", "投票淘汰", "适合语音或文字聊天"]
  },
  gomoku: {
    category: "棋盘对弈",
    intro:
      "黑白双方轮流落子，先在横、竖或斜线上连成五子的一方获胜。每一步先选择落点，再点确认，确认前可以修改。",
    highlights: ["2 人对弈", "精准落点", "落子确认", "每步 2 分钟"]
  },
  ludo: {
    category: "轻量竞速",
    intro:
      "玩家轮流掷骰，根据点数移动棋子，最先抵达终点的人获胜。首版采用简化规则，重点是快速开始和轻松游玩。",
    highlights: ["2-4 人", "轮流掷骰", "先到终点获胜", "超时可投票跳过"]
  },
  catan: {
    category: "策略建设",
    intro:
      "在卡坦岛上采集木材、砖、羊毛、小麦和矿石，修路、建村、升级城市，最先达到 10 分的玩家获胜。",
    highlights: ["3-4 人", "资源采集", "修路建村", "经典核心规则"]
  }
};

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);
const apiUrl = import.meta.env.VITE_API_URL || socketUrl;

const BRAND_NAME = "桌别零";
const initialInviteCode = normalizeRoomCode(
  new URLSearchParams(window.location.search).get("room") || ""
);
const playerId = getSessionPlayerId();

type SignInWithDailyLockoutResult = {
  data: {
    session: Session | null;
    user: Session["user"] | null;
  };
  error: { message: string } | null;
};

async function signInWithDailyLockout(
  email: string,
  password: string
): Promise<SignInWithDailyLockoutResult> {
  if (!supabase) {
    return {
      data: { session: null, user: null },
      error: { message: "填好 Supabase 环境变量后即可使用账号。" }
    };
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    session?: Session;
  };

  if (!response.ok || !payload.session?.access_token || !payload.session.refresh_token) {
    return {
      data: { session: null, user: null },
      error: { message: payload.error || "登录失败，请重新输入账号密码。" }
    };
  }

  const result = await supabase.auth.setSession({
    access_token: payload.session.access_token,
    refresh_token: payload.session.refresh_token
  });

  return result.error
    ? {
        data: { session: null, user: null },
        error: { message: result.error.message }
      }
    : {
        data: {
          session: result.data.session,
          user: result.data.user
        },
        error: null
      };
}

export default function App() {
  const [socketConnected, setSocketConnected] = useState(false);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const autoJoinAttemptedRef = useRef(false);
  const [guestName, setGuestName] = useState(
    localStorage.getItem("board-room-guest-name") || "新玩家"
  );
  const [roomCode, setRoomCode] = useState(() => {
    return initialInviteCode || localStorage.getItem("board-room-last-room") || "";
  });
  const [selectedGame, setSelectedGame] = useState<GameType>("undercover");
  const [activeGame, setActiveGame] = useState<GameType | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [profileName, setProfileName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [profileHonorText, setProfileHonorText] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [signupCodeSent, setSignupCodeSent] = useState(false);
  const [signupCodeCooldown, setSignupCodeCooldown] = useState(0);
  const [sendingSignupCode, setSendingSignupCode] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountPanelView, setAccountPanelView] = useState<AccountPanelView>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const inviteLoginPromptedRef = useRef(false);

  const socket = useMemo(
    () =>
      io(socketUrl, {
        transports: ["websocket", "polling"]
      }),
    []
  );

  const displayName = (profileName || guestName || "新玩家").trim();
  const authToken = session?.access_token;
  const canEnterRooms = Boolean(authToken && session?.user);
  const authProfile = session?.user
    ? {
        userId: session.user.id,
        name: displayName,
        avatarUrl: isAvatarPresetValue(profileAvatarUrl) ? profileAvatarUrl : undefined
      }
    : undefined;

  useEffect(() => {
    const onConnect = () => setSocketConnected(true);
    const onDisconnect = () => setSocketConnected(false);
    const onRoomState = (nextRoom: RoomView) => {
      setRoom(nextRoom);
      setRoomCode(nextRoom.code);
      localStorage.setItem("board-room-last-room", nextRoom.code);
    };
    const onRoomCleared = () => {
      setRoom(null);
      localStorage.removeItem("board-room-last-room");
    };
    const onError = (text: string) => {
      setNotice({ tone: "error", text });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room:joined", onRoomState);
    socket.on("room:state", onRoomState);
    socket.on("room:cleared", onRoomCleared);
    socket.on("error:message", onError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room:joined", onRoomState);
      socket.off("room:state", onRoomState);
      socket.off("room:cleared", onRoomCleared);
      socket.off("error:message", onError);
      socket.disconnect();
    };
  }, [socket]);

  useEffect(() => {
    localStorage.setItem("board-room-guest-name", guestName);
  }, [guestName]);

  useEffect(() => {
    if (
      !socketConnected ||
      room ||
      !initialInviteCode ||
      !authToken ||
      autoJoinAttemptedRef.current
    ) {
      return;
    }

    autoJoinAttemptedRef.current = true;
    socket.emit("room:join", {
      code: initialInviteCode,
      playerId,
      playerName: displayName || "新玩家",
      profile: authProfile,
      authToken
    });
    setNotice({
      tone: "info",
      text: `正在加入房间 ${initialInviteCode}...`
    });
  }, [authProfile, authToken, displayName, room, socket, socketConnected]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (signupCodeCooldown <= 0) return;
    const timer = window.setTimeout(
      () => setSignupCodeCooldown((seconds) => Math.max(0, seconds - 1)),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [signupCodeCooldown]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) {
        void loadProfile(data.session.user.id, data.session.access_token);
      }
      setAuthReady(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        void loadProfile(nextSession.user.id, nextSession.access_token);
      } else {
        setProfileName("");
        setProfileAvatarUrl("");
        setProfileHonorText("");
        setRecords([]);
      }
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user || !supabase) return;
    void loadRecords(session.user.id);
  }, [session?.user?.id]);

  useEffect(() => {
    if (session?.user || !room) return;
    socket.emit("room:leave");
    setRoom(null);
    localStorage.removeItem("board-room-last-room");
    setNotice({ tone: "info", text: "已退出登录，请重新登录后再进入房间。" });
  }, [room, session?.user, socket]);

  useEffect(() => {
    if (
      !initialInviteCode ||
      !authReady ||
      authToken ||
      inviteLoginPromptedRef.current
    ) {
      return;
    }

    inviteLoginPromptedRef.current = true;
    openAuthDialog("signin");
    setNotice({
      tone: "info",
      text: `请先登录或注册账号后再加入房间 ${initialInviteCode}。`
    });
  }, [authReady, authToken]);

  useEffect(() => {
    if (!authReady || !activeGame || session?.user) return;
    setActiveGame(null);
    openAuthDialog("signin");
    setNotice({ tone: "info", text: "请先登录或注册账号后再进入游戏页面。" });
  }, [activeGame, authReady, session?.user]);

  async function loadProfile(userId: string, token?: string) {
    if (!supabase) return;
    const profileToken = token || authToken;
    if (!profileToken) return;

    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/profile`, {
      headers: {
        Authorization: `Bearer ${profileToken}`
      }
    });
    const payload = (await response.json().catch(() => ({}))) as ProfileResponse;

    if (!response.ok) {
      setNotice({
        tone: "error",
        text: payload.error || "读取个人资料失败，请检查 Supabase 配置。"
      });
      return;
    }

    const nextName = payload.displayName || guestName;
    setProfileName(nextName);
    setGuestName(nextName);
    setProfileAvatarUrl(isAvatarPresetValue(payload.avatarUrl) ? payload.avatarUrl : "");
    setProfileHonorText(payload.honorText || "");
  }

  async function loadRecords(userId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("game_records")
      .select("id, game_type, result, player_name, room_code, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (!error && data) {
      setRecords(data as GameRecord[]);
    }
  }

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    if (!supabase) {
      setNotice({ tone: "info", text: "填好 Supabase 环境变量后即可使用账号。" });
      return;
    }

    const cleanEmail = email.trim();
    if (!cleanEmail || password.length < 6) {
      setNotice({ tone: "error", text: "请输入邮箱，密码至少 6 位。" });
      return;
    }
    if (!isLikelyEmail(cleanEmail)) {
      setNotice({ tone: "error", text: "请输入正确的邮箱地址。" });
      return;
    }

    setAuthSubmitting(true);
    try {
      if (authMode === "signup") {
        const cleanCode = signupCode.replace(/\s/g, "");
        if (!cleanCode) {
          setNotice({ tone: "error", text: "请输入邮箱验证码。" });
          return;
        }

        const result = await supabase.auth.verifyOtp({
          email: cleanEmail,
          token: cleanCode,
          type: "email"
        });

        if (result.error || !result.data.session || !result.data.user) {
          setNotice({
            tone: "error",
            text: result.error?.message || "验证码不正确或已过期，请重新发送。"
          });
          return;
        }

        await supabase.auth.setSession({
          access_token: result.data.session.access_token,
          refresh_token: result.data.session.refresh_token
        });

        const update = await supabase.auth.updateUser({
          password,
          data: { display_name: displayName }
        });
        if (update.error) {
          setNotice({ tone: "error", text: update.error.message });
          return;
        }

        await upsertProfile(
          result.data.user.id,
          displayName,
          profileAvatarUrl,
          profileHonorText,
          result.data.session.access_token
        );
        setSignupCode("");
        setSignupCodeSent(false);
        setAuthDialogOpen(false);
        setNotice({ tone: "success", text: "邮箱验证成功，账号已注册并登录。" });
        return;
      }

      const result = await signInWithDailyLockout(cleanEmail, password);

      if (result.error) {
        setNotice({ tone: "error", text: result.error.message });
        return;
      }

      if (result.data.user) {
        await upsertProfile(
          result.data.user.id,
          displayName,
          profileAvatarUrl,
          profileHonorText,
          result.data.session?.access_token
        );
      }

      setAuthDialogOpen(false);
      setNotice({ tone: "success", text: "已登录。" });
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function requestSignupCode() {
    const cleanEmail = email.trim();
    if (!isLikelyEmail(cleanEmail)) {
      setNotice({ tone: "error", text: "请输入正确的邮箱地址。" });
      return;
    }

    setSendingSignupCode(true);
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/auth/signup-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          displayName
        })
      });
      const payload = (await response.json().catch(() => ({}))) as AuthCodeResponse;
      if (!response.ok) {
        if (payload.retryAfterSeconds) {
          setSignupCodeCooldown(payload.retryAfterSeconds);
        }
        setNotice({ tone: "error", text: payload.error || "验证码发送失败。" });
        return;
      }

      setSignupCodeSent(true);
      setSignupCodeCooldown(payload.retryAfterSeconds || 30);
      setNotice({ tone: "success", text: "验证码已发送，请查看邮箱。" });
    } finally {
      setSendingSignupCode(false);
    }
  }

  async function upsertProfile(
    userId: string,
    name: string,
    avatarUrl = profileAvatarUrl,
    honorText = profileHonorText,
    token?: string
  ) {
    if (!supabase) return;
    const cleanName = name.trim() || "新玩家";
    const cleanAvatarUrl = isAvatarPresetValue(avatarUrl) ? avatarUrl : "";
    const profileToken = token || authToken;
    if (!profileToken) {
      setNotice({ tone: "error", text: "请先登录后再保存个人资料。" });
      return;
    }

    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/profile`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${profileToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId,
        displayName: cleanName,
        avatarUrl: cleanAvatarUrl,
        honorText
      })
    });
    const payload = (await response.json().catch(() => ({}))) as ProfileResponse;

    if (!response.ok) {
      setNotice({ tone: "error", text: payload.error || "保存个人资料失败。" });
      return;
    }

    const savedName = payload.displayName || cleanName;
    setProfileName(savedName);
    setProfileAvatarUrl(isAvatarPresetValue(payload.avatarUrl) ? payload.avatarUrl : "");
    setProfileHonorText(payload.honorText || "");
    setGuestName(savedName);
    setNotice({ tone: "success", text: "个人资料已保存。" });
  }

  function createRoom() {
    if (!authToken || !authProfile) {
      openAuthDialog("signin");
      setNotice({ tone: "info", text: "请先登录或注册账号后再创建房间。" });
      return;
    }

    const playerName = displayName || "新玩家";
    socket.emit("room:create", {
      playerId,
      playerName,
      gameType: selectedGame,
      profile: authProfile,
      authToken
    });
  }

  function joinRoom(event?: FormEvent) {
    event?.preventDefault();
    if (!authToken || !authProfile) {
      openAuthDialog("signin");
      setNotice({ tone: "info", text: "请先登录或注册账号后再加入房间。" });
      return;
    }

    const code = roomCode.trim().toUpperCase();
    if (!code) {
      setNotice({ tone: "error", text: "请输入房间号。" });
      return;
    }

    socket.emit("room:join", {
      code,
      playerId,
      playerName: displayName || "新玩家",
      profile: authProfile,
      authToken
    });
  }

  function leaveRoom() {
    socket.emit("room:leave");
    setRoom(null);
    localStorage.removeItem("board-room-last-room");
  }

  function openGame(gameType: GameType) {
    if (!authToken || !session?.user) {
      openAuthDialog("signin");
      setNotice({ tone: "info", text: "请先登录或注册账号后再进入游戏页面。" });
      return;
    }

    setSelectedGame(gameType);
    setActiveGame(gameType);
    setAccountMenuOpen(false);
  }

  function returnHome() {
    setActiveGame(null);
  }

  function openAuthDialog(mode: "signin" | "signup" = "signin") {
    setAuthMode(mode);
    setAuthDialogOpen(true);
    setAccountMenuOpen(false);
    setAccountPanelView(null);
  }

  function changeAuthMode(mode: "signin" | "signup") {
    setAuthMode(mode);
    if (mode === "signin") {
      setSignupCode("");
    }
  }

  if (accountPanelView) {
    return (
      <AccountPage
        view={accountPanelView}
        configured={isSupabaseConfigured}
        session={session}
        displayName={session?.user ? profileName : guestName}
        avatarUrl={profileAvatarUrl}
        honorText={profileHonorText}
        email={email}
        password={password}
        signupCode={signupCode}
        signupCodeSent={signupCodeSent}
        signupCodeCooldown={signupCodeCooldown}
        sendingSignupCode={sendingSignupCode}
        submitting={authSubmitting}
        records={records}
        authMode={authMode}
        notice={notice}
        onClose={() => setAccountPanelView(null)}
        onNameChange={setProfileName}
        onAvatarChange={setProfileAvatarUrl}
        onHonorTextChange={setProfileHonorText}
        onProfileSave={() =>
          session?.user &&
          void upsertProfile(
            session.user.id,
            profileName,
            profileAvatarUrl,
            profileHonorText
          )
        }
        onSignOut={() => {
          setAccountPanelView(null);
          void supabase?.auth.signOut();
        }}
        onAuthModeChange={changeAuthMode}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onSignupCodeChange={setSignupCode}
        onRequestSignupCode={requestSignupCode}
        onAuthSubmit={handleAuth}
      />
    );
  }

  if (room) {
    return (
      <RoomScreen
        room={room}
        playerId={playerId}
        socket={socket}
        onLeave={leaveRoom}
        onNotice={setNotice}
        socketConnected={socketConnected}
        notice={notice}
        accountMenu={
          <HomeAccountMenu
            displayName={displayName}
            avatarUrl={profileAvatarUrl}
            email={session?.user.email || ""}
            isSignedIn={Boolean(session?.user)}
            menuOpen={accountMenuOpen}
            onToggle={() => setAccountMenuOpen((open) => !open)}
            onAuthOpen={openAuthDialog}
            onSelect={(view) => {
              setAccountPanelView(view);
              setAccountMenuOpen(false);
            }}
            onSignOut={() => {
              setAccountMenuOpen(false);
              setAccountPanelView(null);
              void supabase?.auth.signOut();
            }}
          />
        }
      />
    );
  }

  if (!activeGame) {
    return (
      <>
        <main className="app-shell home-shell">
          <section className="home-title-band">
            <div className="brand-lockup">
              <img className="brand-mark" src={brandLogoUrl} alt="桌别零图形标识" />
              <div>
                <div className="eyebrow">
                  <Gamepad2 size={16} />
                  在线桌游
                </div>
                <h1>{BRAND_NAME}</h1>
              </div>
            </div>
            <div className="home-header-actions">
              <div className={socketConnected ? "status online" : "status offline"}>
                {socketConnected ? <Wifi size={18} /> : <WifiOff size={18} />}
                {socketConnected ? "服务器已连接" : "连接中"}
              </div>
              <HomeAccountMenu
                displayName={displayName}
                avatarUrl={profileAvatarUrl}
                email={session?.user.email || ""}
                isSignedIn={Boolean(session?.user)}
                menuOpen={accountMenuOpen}
                onToggle={() => setAccountMenuOpen((open) => !open)}
                onAuthOpen={openAuthDialog}
                onSelect={(view) => {
                  setAccountPanelView(view);
                  setAccountMenuOpen(false);
                }}
                onSignOut={() => {
                  setAccountMenuOpen(false);
                  setAccountPanelView(null);
                  void supabase?.auth.signOut();
                }}
              />
            </div>
          </section>

          {notice && <NoticeBar notice={notice} />}

          <section className="category-list">
            {gameCategories.map((category) => (
              <div className="game-category" key={category.title}>
                <div className="category-heading">
                  <span className="panel-kicker">游戏类别</span>
                  <h2>{category.title}</h2>
                  <p>{category.description}</p>
                </div>
                <div className="category-games">
                  {category.games.map((type) => (
                    <button
                      className="home-game-card"
                      key={type}
                      onClick={() => openGame(type)}
                      type="button"
                    >
                      <GameGlyph type={type} />
                      <span>{GAME_META[type].name}</span>
                      <small>{GAME_META[type].shortDescription}</small>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </main>
        {authDialogOpen && !session?.user && (
          <AuthDialog
            configured={isSupabaseConfigured}
            mode={authMode}
            email={email}
            password={password}
            signupCode={signupCode}
            signupCodeSent={signupCodeSent}
            signupCodeCooldown={signupCodeCooldown}
            sendingSignupCode={sendingSignupCode}
            submitting={authSubmitting}
            onClose={() => setAuthDialogOpen(false)}
            onModeChange={changeAuthMode}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSignupCodeChange={setSignupCode}
            onRequestSignupCode={requestSignupCode}
            onSubmit={handleAuth}
          />
        )}
      </>
    );
  }

  const gameMeta = GAME_META[selectedGame];
  const gameDetail = gameDetails[selectedGame];

  return (
    <main className="app-shell game-detail-shell">
      <div className="page-topbar">
        <button className="icon-text-button back-button" type="button" onClick={returnHome}>
          <ArrowLeft size={18} />
          返回首页
        </button>
        <HomeAccountMenu
          displayName={displayName}
          avatarUrl={profileAvatarUrl}
          email={session?.user.email || ""}
          isSignedIn={Boolean(session?.user)}
          menuOpen={accountMenuOpen}
          onToggle={() => setAccountMenuOpen((open) => !open)}
          onAuthOpen={openAuthDialog}
          onSelect={(view) => {
            setAccountPanelView(view);
            setAccountMenuOpen(false);
          }}
          onSignOut={() => {
            setAccountMenuOpen(false);
            setAccountPanelView(null);
            void supabase?.auth.signOut();
          }}
        />
      </div>

      <section className="game-detail-hero">
        <div className="game-detail-title">
          <GameGlyph type={selectedGame} large />
          <div>
            <span className="panel-kicker">{gameDetail.category}</span>
            <h1>{gameMeta.name}</h1>
            <p>{gameMeta.shortDescription}</p>
          </div>
        </div>

        <div className="create-room-box">
          <div className="current-player-card">
            <span className="current-player-avatar">
              <AvatarFigure avatarUrl={profileAvatarUrl} fallback={initialOf(displayName)} />
            </span>
            <div>
              <span>当前账号</span>
              <strong>{displayName || "新玩家"}</strong>
            </div>
          </div>
          <button className="primary-action" onClick={createRoom}>
            <DoorOpen size={20} />
            {canEnterRooms ? "创建房间" : "请先注册/登录"}
          </button>
        </div>
      </section>

      {notice && <NoticeBar notice={notice} />}

      <section className="game-detail-grid">
        <div className="panel intro-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">游戏简介</span>
              <h2>{gameMeta.name}</h2>
            </div>
            <Info size={22} />
          </div>
          <p>{gameDetail.intro}</p>
          <div className="rule-strip detail-rules">
            <span>
              {gameMeta.minPlayers}-{gameMeta.maxPlayers} 人
            </span>
            <span>每步 2 分钟</span>
            <span>超时可投票跳过</span>
            <span>注册后游玩</span>
          </div>
          <div className="highlight-grid">
            {gameDetail.highlights.map((highlight) => (
              <span key={highlight}>{highlight}</span>
            ))}
          </div>
        </div>

        <div className="panel command-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">加入</span>
              <h2>输入房间号</h2>
            </div>
            <Users size={22} />
          </div>

          <form className="join-form" onSubmit={joinRoom}>
            <label className="field">
              <span>6 位房间号</span>
              <input
                className="room-code-input"
                value={roomCode}
                maxLength={6}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="AB12CD"
              />
            </label>
            <button className="secondary-action" type="submit">
              <UserPlus size={20} />
              {canEnterRooms ? "加入房间" : "请先注册/登录"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function RoomScreen({
  room,
  playerId,
  socket,
  onLeave,
  onNotice,
  socketConnected,
  notice,
  accountMenu
}: {
  room: RoomView;
  playerId: string;
  socket: Socket;
  onLeave: () => void;
  onNotice: (notice: Notice) => void;
  socketConnected: boolean;
  notice: Notice | null;
  accountMenu: ReactNode;
}) {
  const [chatText, setChatText] = useState("");
  const me = room.players.find((player) => player.id === playerId);
  const isHost = room.hostId === playerId;
  const gameMeta = GAME_META[room.selectedGame];
  const shareLink = `${window.location.origin}${window.location.pathname}?room=${room.code}`;
  const inviteText = `来桌别零一起玩 ${gameMeta.name}，房间号 ${room.code}：${shareLink}`;
  const connectedPlayers = room.players.filter((player) => player.connected);
  const allReady = connectedPlayers
    .filter((player) => player.id !== room.hostId)
    .every((player) => player.ready);

  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    socket.emit("chat:send", { text });
    setChatText("");
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteText);
      onNotice({ tone: "success", text: "邀请文案已复制。" });
    } catch {
      onNotice({ tone: "error", text: "复制失败，请手动复制房间链接。" });
    }
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="room-title-lockup">
          <img className="brand-mark small" src={brandLogoUrl} alt="桌别零图形标识" />
          <div>
            <span className="panel-kicker">
              {BRAND_NAME} · {gameMeta.name}
            </span>
            <h1>房间 {room.code}</h1>
          </div>
        </div>
        <div className="room-actions">
          <button className="icon-text-button" onClick={copyInvite}>
            <Copy size={18} />
            复制邀请
          </button>
          <button className="icon-text-button danger" onClick={onLeave}>
            <LogOut size={18} />
            离开
          </button>
          {accountMenu}
        </div>
      </header>

      {notice && <NoticeBar notice={notice} />}

      <section className="room-grid">
        <aside className="side-panel">
          <div className={socketConnected ? "status online" : "status offline"}>
            {socketConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            {socketConnected ? "同步中" : "离线"}
          </div>

          <div className="invite-block">
            <div className="invite-heading">
              <QrCode size={18} />
              <h2>邀请好友</h2>
            </div>
            <div className="qr-frame">
              <QRCodeSVG
                value={shareLink}
                size={150}
                bgColor="#ffffff"
                fgColor="#062f46"
                marginSize={2}
              />
            </div>
            <code className="room-code-badge">{room.code}</code>
            <p className="hint">朋友扫码或打开邀请链接后，会自动尝试加入这个房间。</p>
            <button className="secondary-action" onClick={copyInvite}>
              <Copy size={18} />
              复制邀请文案
            </button>
          </div>

          <div className="room-control-block">
            <h2>玩家</h2>
            <div className="player-list">
              {room.players.map((player) => (
                <PlayerRow key={player.id} player={player} isMe={player.id === playerId} />
              ))}
            </div>
          </div>

          {room.phase === "lobby" && (
            <div className="room-control-block">
              <h2>准备</h2>
              {isHost ? (
                <>
                  <GamePicker
                    selected={room.selectedGame}
                    onSelect={(gameType) =>
                      socket.emit("room:selectGame", { gameType })
                    }
                    compact
                  />
                  <button
                    className="primary-action"
                    onClick={() => socket.emit("room:start")}
                    disabled={!allReady || connectedPlayers.length < gameMeta.minPlayers}
                  >
                    <Play size={19} />
                    开始游戏
                  </button>
                </>
              ) : (
                <button
                  className={me?.ready ? "secondary-action ready" : "secondary-action"}
                  onClick={() => socket.emit("room:ready", { ready: !me?.ready })}
                >
                  <Check size={19} />
                  {me?.ready ? "已准备" : "准备"}
                </button>
              )}
              <p className="hint">
                {gameMeta.minPlayers}-{gameMeta.maxPlayers} 人，非房主准备后房主开始。
              </p>
            </div>
          )}

          {room.phase === "ended" && isHost && (
            <button className="secondary-action" onClick={() => socket.emit("room:restart")}>
              <RefreshCw size={19} />
              回到等待区
            </button>
          )}
        </aside>

        <section className="game-stage">
          {room.phase === "lobby" ? (
            <LobbyPreview room={room} />
          ) : (
            <GameSurface room={room} playerId={playerId} socket={socket} />
          )}
        </section>

        <aside className="chat-panel">
          <h2>房间聊天</h2>
          <div className="chat-log">
            {room.chat.map((message) => (
              <div
                className={message.playerId === "system" ? "chat system" : "chat"}
                key={message.id}
              >
                <span>{message.playerName}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={sendChat}>
            <input
              value={chatText}
              maxLength={200}
              onChange={(event) => setChatText(event.target.value)}
              placeholder="说点什么..."
            />
            <button aria-label="发送聊天" type="submit">
              <Send size={18} />
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}

function GameSurface({
  room,
  playerId,
  socket
}: {
  room: RoomView;
  playerId: string;
  socket: Socket;
}) {
  const gameState = room.gameState;
  if (!gameState) return <LobbyPreview room={room} />;

  if (gameState.type === "undercover") {
    return (
      <UndercoverGame
        room={room}
        state={gameState}
        playerId={playerId}
        socket={socket}
      />
    );
  }

  if (gameState.type === "gomoku") {
    return (
      <GomokuGame
        room={room}
        state={gameState}
        playerId={playerId}
        socket={socket}
      />
    );
  }

  if (gameState.type === "catan") {
    return (
      <CatanGame
        room={room}
        state={gameState}
        playerId={playerId}
        socket={socket}
      />
    );
  }

  return (
    <LudoGame
      room={room}
      state={gameState}
      playerId={playerId}
      socket={socket}
    />
  );
}

function UndercoverGame({
  room,
  state,
  playerId,
  socket
}: {
  room: RoomView;
  state: UndercoverPublicState;
  playerId: string;
  socket: Socket;
}) {
  const [showWord, setShowWord] = useState(false);
  const currentSpeaker = room.players.find(
    (player) => player.id === state.currentSpeakerId
  );
  const timeLeftMs = useCountdown(state.turnEndsAt);
  const timePercent = state.turnDurationMs
    ? Math.max(0, Math.min(100, (timeLeftMs / state.turnDurationMs) * 100))
    : 0;
  const activePlayers = room.players.filter(
    (player) => !state.eliminatedIds.includes(player.id)
  );
  const isEliminated = state.eliminatedIds.includes(playerId);
  const canAdvance =
    !state.skipVote &&
    (room.hostId === playerId || state.currentSpeakerId === playerId);
  const voteCounts = Object.values(state.votes).reduce<Record<string, number>>(
    (counts, targetId) => {
      counts[targetId] = (counts[targetId] || 0) + 1;
      return counts;
    },
    {}
  );

  return (
    <div className="game-layout">
      <div className="game-title-row">
        <div>
          <span className="panel-kicker">第 {state.round} 轮</span>
          <h2>谁是卧底</h2>
        </div>
        <span className="stage-pill">
          {state.stage === "speaking"
            ? "轮流发言"
            : state.stage === "voting"
              ? "投票中"
              : "已结束"}
        </span>
      </div>

      <div className="secret-word">
        <span>你的词语</span>
        <strong>{showWord || state.stage === "ended" ? state.myWord : "••••"}</strong>
        <button onClick={() => setShowWord((visible) => !visible)}>
          {showWord ? <EyeOff size={18} /> : <Eye size={18} />}
          {showWord ? "隐藏" : "查看"}
        </button>
      </div>

      {state.reason && <p className="result-line">{state.reason}</p>}

      {state.stage !== "ended" && !state.skipVote && (
        <div className="turn-confirm-panel">
          <div className="timer-card">
            <span>本步剩余</span>
            <strong>{formatDuration(timeLeftMs)}</strong>
            <div className="timer-track">
              <i style={{ width: `${timePercent}%` }} />
            </div>
          </div>
          <div className="move-confirm-card">
            <span>
              {state.stage === "speaking"
                ? currentSpeaker
                  ? `${currentSpeaker.name} 需要在 2 分钟内完成发言`
                  : "发言阶段限时 2 分钟"
                : "投票阶段限时 2 分钟，时间到会按已投票结果结算"}
            </span>
          </div>
        </div>
      )}

      {state.skipVote && (
        <SkipVotePanel
          room={room}
          playerId={playerId}
          socket={socket}
          skipVote={state.skipVote}
        />
      )}

      {state.stage === "speaking" && (
        <div className="turn-panel">
          <span>当前发言</span>
          <strong>{currentSpeaker?.name || "等待中"}</strong>
          <p>
            已完成 {state.spokenCount}/{activePlayers.length} 位玩家发言。
          </p>
          <button
            className="primary-action"
            disabled={!canAdvance}
            onClick={() => socket.emit("game:action", { type: "undercover:next-speaker" })}
          >
            <Play size={19} />
            下一位
          </button>
        </div>
      )}

      {state.stage === "voting" && (
        <div className="vote-grid">
          {activePlayers.map((player) => (
            <button
              key={player.id}
              className={state.votes[playerId] === player.id ? "vote selected" : "vote"}
              disabled={isEliminated || Boolean(state.votes[playerId]) || Boolean(state.skipVote)}
              onClick={() =>
                socket.emit("game:action", {
                  type: "undercover:vote",
                  targetId: player.id
                })
              }
            >
              <span style={{ background: player.color }}>{initialOf(player.name)}</span>
              {player.name}
              <small>{voteCounts[player.id] || 0} 票</small>
            </button>
          ))}
        </div>
      )}

      {state.stage === "ended" && (
        <div className="winner-panel">
          <strong>
            {state.winnerTeam === "undercover" ? "卧底胜利" : "平民胜利"}
          </strong>
          <p>{state.reason}</p>
        </div>
      )}

      <div className="identity-board">
        {room.players.map((player) => {
          const eliminated = state.eliminatedIds.includes(player.id);
          return (
            <div className={eliminated ? "identity eliminated" : "identity"} key={player.id}>
              <span style={{ background: player.color }}>{initialOf(player.name)}</span>
              <div>
                <strong>{player.name}</strong>
                <small>
                  {eliminated
                    ? "已出局"
                    : state.currentSpeakerId === player.id
                      ? "发言中"
                      : "在场"}
                  {state.revealedRoles?.[player.id]
                    ? ` · ${state.revealedRoles[player.id] === "undercover" ? "卧底" : "平民"}`
                    : ""}
                </small>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GomokuGame({
  room,
  state,
  playerId,
  socket
}: {
  room: RoomView;
  state: GomokuPublicState;
  playerId: string;
  socket: Socket;
}) {
  const [selectedMove, setSelectedMove] = useState<{ x: number; y: number } | null>(
    null
  );
  const current = room.players.find((player) => player.id === state.currentPlayerId);
  const winner = room.players.find((player) => player.id === state.winnerId);
  const timeoutLoser = room.players.find(
    (player) => player.id === state.timeoutLoserId
  );
  const myStone = state.playerStones[playerId];
  const isMyTurn = state.currentPlayerId === playerId;
  const canSelectMove =
    isMyTurn &&
    !state.skipVote &&
    !state.winnerId &&
    !state.isDraw &&
    Boolean(myStone);
  const timeLeftMs = useCountdown(state.turnEndsAt);
  const timePercent = state.turnDurationMs
    ? Math.max(0, Math.min(100, (timeLeftMs / state.turnDurationMs) * 100))
    : 0;
  const winningSet = new Set(
    state.winningLine?.map(([x, y]) => `${x}:${y}`) || []
  );

  useEffect(() => {
    setSelectedMove(null);
  }, [state.currentPlayerId, state.moves, state.winnerId, state.isDraw]);

  function selectMove(x: number, y: number) {
    if (!canSelectMove || state.board[y][x]) return;
    setSelectedMove({ x, y });
  }

  function confirmMove() {
    if (!selectedMove || !canSelectMove) return;
    socket.emit("game:action", {
      type: "gomoku:place",
      x: selectedMove.x,
      y: selectedMove.y
    });
  }

  return (
    <div className="game-layout gomoku-layout">
      <div className="game-title-row">
        <div>
          <span className="panel-kicker">15 x 15</span>
          <h2>五子棋</h2>
        </div>
        <span className="stage-pill">
          {winner ? `${winner.name} 胜利` : state.isDraw ? "平局" : `轮到 ${current?.name || "等待"}`}
        </span>
      </div>

      {state.skipVote && (
        <SkipVotePanel
          room={room}
          playerId={playerId}
          socket={socket}
          skipVote={state.skipVote}
        />
      )}

      {!state.skipVote && (
      <div className="turn-confirm-panel">
        <div className="timer-card">
          <span>本手剩余</span>
          <strong>{formatDuration(timeLeftMs)}</strong>
          <div className="timer-track">
            <i style={{ width: `${timePercent}%` }} />
          </div>
        </div>
        <div className="move-confirm-card">
          <span>
            {state.resultReason ||
              (canSelectMove
                ? selectedMove
                  ? `已选择：第 ${selectedMove.y + 1} 行，第 ${selectedMove.x + 1} 列`
                  : "先点棋盘选择落点"
                : current
                  ? `等待 ${current.name} 确认落子`
                  : "本局已结束")}
          </span>
          {timeoutLoser && <small>{timeoutLoser.name} 超时未确认。</small>}
          <button
            className="primary-action"
            disabled={!selectedMove || !canSelectMove}
            onClick={confirmMove}
          >
            <Check size={19} />
            确认落子
          </button>
        </div>
      </div>
      )}

      <div className="stone-legend">
        {room.players.slice(0, 2).map((player) => (
          <span key={player.id}>
            <i className={`stone ${state.playerStones[player.id]}`} />
            {player.name}
          </span>
        ))}
      </div>

      <div
        className="gomoku-board"
        style={{ "--board-size": state.size } as CSSProperties}
      >
        {state.board.map((row, y) =>
          row.map((stone, x) => (
            <button
              key={`${x}-${y}`}
              className={[
                "cell",
                winningSet.has(`${x}:${y}`) ? "winning" : "",
                selectedMove?.x === x && selectedMove.y === y ? "selected" : "",
                canSelectMove && !stone ? "selectable" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={
                Boolean(stone) ||
                Boolean(state.winnerId) ||
                state.isDraw ||
                !canSelectMove ||
                !myStone
              }
              onClick={() => selectMove(x, y)}
              aria-label={`第 ${y + 1} 行第 ${x + 1} 列`}
            >
              {stone && <i className={`stone ${stone}`} />}
              {!stone && selectedMove?.x === x && selectedMove.y === y && myStone && (
                <i className={`stone preview ${myStone}`} />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function LudoGame({
  room,
  state,
  playerId,
  socket
}: {
  room: RoomView;
  state: LudoPublicState;
  playerId: string;
  socket: Socket;
}) {
  const current = room.players.find((player) => player.id === state.currentPlayerId);
  const winner = room.players.find((player) => player.id === state.winnerId);
  const timeoutLoser = room.players.find(
    (player) => player.id === state.timeoutLoserId
  );
  const timeLeftMs = useCountdown(state.turnEndsAt);
  const timePercent = state.turnDurationMs
    ? Math.max(0, Math.min(100, (timeLeftMs / state.turnDurationMs) * 100))
    : 0;
  const track = Array.from({ length: state.finish + 1 }, (_, index) => index);

  return (
    <div className="game-layout ludo-layout">
      <div className="game-title-row">
        <div>
          <span className="panel-kicker">第 {state.turnCount} 手</span>
          <h2>飞行棋简版</h2>
        </div>
        <span className="stage-pill">
          {winner ? `${winner.name} 抵达终点` : `轮到 ${current?.name || "等待"}`}
        </span>
      </div>

      {state.skipVote && (
        <SkipVotePanel
          room={room}
          playerId={playerId}
          socket={socket}
          skipVote={state.skipVote}
        />
      )}

      {!winner && !state.skipVote && (
        <div className="turn-confirm-panel">
          <div className="timer-card">
            <span>本步剩余</span>
            <strong>{formatDuration(timeLeftMs)}</strong>
            <div className="timer-track">
              <i style={{ width: `${timePercent}%` }} />
            </div>
          </div>
          <div className="move-confirm-card">
            <span>
              {state.resultReason ||
                (current
                  ? `${current.name} 需要在 2 分钟内掷骰`
                  : "本局已结束")}
            </span>
            {timeoutLoser && <small>{timeoutLoser.name} 超时未掷骰。</small>}
          </div>
        </div>
      )}

      <div className="dice-panel">
        <button
          className="primary-action"
          disabled={
            state.currentPlayerId !== playerId ||
            Boolean(state.winnerId) ||
            Boolean(state.skipVote)
          }
          onClick={() => socket.emit("game:action", { type: "ludo:roll" })}
        >
          <Dice6 size={20} />
          掷骰前进
        </button>
        <strong>{state.lastRoll ? state.lastRoll.value : "-"}</strong>
      </div>

      <div className="ludo-track">
        {track.map((step) => {
          const tokens = room.players.filter(
            (player) => state.positions[player.id] === step
          );
          return (
            <div className={step === state.finish ? "track-cell finish" : "track-cell"} key={step}>
              <small>{step}</small>
              <div>
                {tokens.map((player) => (
                  <span
                    key={player.id}
                    className="mini-token"
                    style={{ background: player.color }}
                  >
                    {initialOf(player.name)}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="race-list">
        {room.players.map((player) => {
          const position = state.positions[player.id] || 0;
          return (
            <div className="race-row" key={player.id}>
              <span style={{ background: player.color }}>{initialOf(player.name)}</span>
              <strong>{player.name}</strong>
              <progress value={position} max={state.finish} />
              <small>
                {position}/{state.finish}
              </small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LobbyPreview({ room }: { room: RoomView }) {
  return (
    <div className="lobby-preview">
      <GameGlyph type={room.selectedGame} large />
      <div>
        <span className="panel-kicker">等待区</span>
        <h2>{GAME_META[room.selectedGame].name}</h2>
        <p>{GAME_META[room.selectedGame].shortDescription}</p>
      </div>
      <div className="rule-strip">
        <span>{GAME_META[room.selectedGame].minPlayers} 人起玩</span>
        <span>房主开始</span>
        <span>文字聊天</span>
      </div>
    </div>
  );
}

function GamePicker({
  selected,
  onSelect,
  compact = false
}: {
  selected: GameType;
  onSelect: (gameType: GameType) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "game-picker compact" : "game-picker"}>
      {(Object.keys(GAME_META) as GameType[]).map((type) => (
        <button
          className={selected === type ? "game-card selected" : "game-card"}
          key={type}
          onClick={() => onSelect(type)}
          type="button"
        >
          <GameGlyph type={type} />
          <strong>{GAME_META[type].name}</strong>
          {!compact && <small>{GAME_META[type].shortDescription}</small>}
        </button>
      ))}
    </div>
  );
}

function GameGlyph({ type, large = false }: { type: GameType; large?: boolean }) {
  if (type === "gomoku") {
    return (
      <div className={large ? "glyph gomoku large" : "glyph gomoku"}>
        {Array.from({ length: 25 }, (_, index) => (
          <i
            key={index}
            className={
              [6, 12, 18].includes(index)
                ? "black"
                : [8, 13].includes(index)
                  ? "white"
                  : ""
            }
          />
        ))}
      </div>
    );
  }

  if (type === "ludo") {
    return (
      <div className={large ? "glyph ludo large" : "glyph ludo"}>
        <span />
        <span />
        <Dice6 size={large ? 34 : 22} />
        <span />
      </div>
    );
  }

  if (type === "catan") {
    return (
      <div className={large ? "glyph catan large" : "glyph catan"}>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <strong>10</strong>
      </div>
    );
  }

  return (
    <div className={large ? "glyph undercover large" : "glyph undercover"}>
      <span>词</span>
      <span>?</span>
    </div>
  );
}

function PlayerRow({ player, isMe }: { player: Player; isMe: boolean }) {
  return (
    <div className={player.connected ? "player-row" : "player-row disconnected"}>
      <span className="avatar" style={{ background: player.color }}>
        {initialOf(player.name)}
      </span>
      <div>
        <strong>
          {player.name}
          {isMe ? "（你）" : ""}
        </strong>
        <small>
          {player.isHost ? "房主" : player.ready ? "已准备" : "未准备"}
          {player.connected ? "" : " · 离线"}
        </small>
      </div>
      {player.isHost ? <Crown size={18} /> : player.ready ? <Check size={18} /> : <CircleDot size={18} />}
    </div>
  );
}

function CatanGame({
  room,
  state,
  playerId,
  socket
}: {
  room: RoomView;
  state: CatanPublicState;
  playerId: string;
  socket: Socket;
}) {
  const [tradeGive, setTradeGive] = useState<CatanResource>("wood");
  const [tradeReceive, setTradeReceive] = useState<CatanResource>("brick");
  const current = room.players.find((player) => player.id === state.currentPlayerId);
  const winner = room.players.find((player) => player.id === state.winnerId);
  const myState = state.playerStates[playerId];
  const isMyTurn = state.currentPlayerId === playerId && !state.skipVote;
  const timeLeftMs = useCountdown(state.turnEndsAt);
  const timePercent = state.turnDurationMs
    ? Math.max(0, Math.min(100, (timeLeftMs / state.turnDurationMs) * 100))
    : 0;
  const viewBox = catanViewBox(state);

  function handleHexClick(hexId: string) {
    if (!isMyTurn || !state.needsRobberMove) return;
    socket.emit("game:action", { type: "catan:move-robber", hexId });
  }

  function handleVertexClick(vertexId: string) {
    if (!isMyTurn) return;
    const vertex = state.vertices.find((entry) => entry.id === vertexId);
    if (!vertex?.building) {
      socket.emit("game:action", { type: "catan:place-settlement", vertexId });
      return;
    }

    if (
      state.phase === "playing" &&
      state.hasRolled &&
      !state.needsRobberMove &&
      vertex.building.playerId === playerId &&
      vertex.building.kind === "settlement"
    ) {
      socket.emit("game:action", { type: "catan:upgrade-city", vertexId });
    }
  }

  function handleEdgeClick(edgeId: string) {
    if (!isMyTurn) return;
    socket.emit("game:action", { type: "catan:place-road", edgeId });
  }

  return (
    <div className="game-layout catan-layout">
      <div className="game-title-row">
        <div>
          <span className="panel-kicker">
            {state.phase === "setup" ? "开局放置" : "经典核心版"}
          </span>
          <h2>卡坦岛</h2>
        </div>
        <span className="stage-pill">
          {winner
            ? `${winner.name} 胜利`
            : state.phase === "setup"
              ? `${current?.name || "等待"} 放${state.setupPhase === "road" ? "道路" : "村庄"}`
              : `轮到 ${current?.name || "等待"}`}
        </span>
      </div>

      {state.resultReason && <p className="result-line">{state.resultReason}</p>}

      {state.skipVote ? (
        <SkipVotePanel
          room={room}
          playerId={playerId}
          socket={socket}
          skipVote={state.skipVote}
        />
      ) : (
        <div className="turn-confirm-panel">
          <div className="timer-card">
            <span>本步剩余</span>
            <strong>{formatDuration(timeLeftMs)}</strong>
            <div className="timer-track">
              <i style={{ width: `${timePercent}%` }} />
            </div>
          </div>
          <div className="move-confirm-card">
            <span>
              {state.phase === "setup"
                ? "按提示在地图交点放村庄，再点相邻边放道路。"
                : state.needsRobberMove
                  ? "掷出 7，请点击一个地形块移动盗贼。"
                  : state.hasRolled
                    ? "点击地图边修路，点击空交点建村，点击自己的村庄升级城市。"
                    : "先掷骰，获得资源后再建造。"}
            </span>
          </div>
        </div>
      )}

      <div className="catan-board-wrap">
        <svg className="catan-board" viewBox={viewBox}>
          {state.hexes.map((hex) => (
            <g key={hex.id} onClick={() => handleHexClick(hex.id)}>
              <polygon
                className={`catan-hex terrain-${hex.terrain}`}
                points={catanPolygonPoints(hex.x, hex.y)}
              />
              <text className="catan-hex-label" x={hex.x} y={hex.y - 0.18}>
                {terrainLabel(hex.terrain)}
              </text>
              {hex.number && (
                <text
                  className={
                    hex.number === 6 || hex.number === 8
                      ? "catan-number hot"
                      : "catan-number"
                  }
                  x={hex.x}
                  y={hex.y + 0.28}
                >
                  {hex.number}
                </text>
              )}
              {state.robberHexId === hex.id && (
                <text className="catan-robber" x={hex.x} y={hex.y + 0.74}>
                  盗贼
                </text>
              )}
            </g>
          ))}

          {state.edges.map((edge) => {
            const owner = room.players.find((player) => player.id === edge.roadOwnerId);
            return (
              <g key={edge.id} onClick={() => handleEdgeClick(edge.id)}>
                <line
                  className={edge.roadOwnerId ? "catan-road owned" : "catan-road"}
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  style={edge.roadOwnerId ? { stroke: owner?.color } : undefined}
                />
                <line
                  className="catan-road-hit"
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                />
              </g>
            );
          })}

          {state.vertices.map((vertex) => {
            const owner = room.players.find(
              (player) => player.id === vertex.building?.playerId
            );
            return (
              <g key={vertex.id} onClick={() => handleVertexClick(vertex.id)}>
                <circle
                  className={
                    vertex.building
                      ? `catan-building ${vertex.building.kind}`
                      : "catan-vertex"
                  }
                  cx={vertex.x}
                  cy={vertex.y}
                  r={vertex.building?.kind === "city" ? 0.18 : 0.13}
                  style={vertex.building ? { fill: owner?.color } : undefined}
                />
                <circle className="catan-vertex-hit" cx={vertex.x} cy={vertex.y} r={0.26} />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="catan-action-grid">
        <div className="catan-resource-panel">
          <span className="panel-kicker">我的资源</span>
          <div className="resource-chips">
            {catanResourceOrder.map((resource) => (
              <span key={resource}>
                {resourceLabel(resource)}
                <strong>{myState?.resources[resource] || 0}</strong>
              </span>
            ))}
          </div>
          <small>
            修路：木+砖；建村：木+砖+羊+麦；城市：2 麦+3 矿。
          </small>
        </div>

        <div className="catan-control-panel">
          <div className="dice-panel catan-dice-panel">
            <button
              className="primary-action"
              disabled={!isMyTurn || state.phase !== "playing" || state.hasRolled}
              onClick={() => socket.emit("game:action", { type: "catan:roll" })}
            >
              <Dice6 size={20} />
              掷骰
            </button>
            <strong>{state.lastRoll ? state.lastRoll.total : "-"}</strong>
          </div>

          <div className="bank-trade-row">
            <select
              value={tradeGive}
              onChange={(event) => setTradeGive(event.target.value as CatanResource)}
            >
              {catanResourceOrder.map((resource) => (
                <option key={resource} value={resource}>
                  {resourceLabel(resource)}
                </option>
              ))}
            </select>
            <span>换</span>
            <select
              value={tradeReceive}
              onChange={(event) => setTradeReceive(event.target.value as CatanResource)}
            >
              {catanResourceOrder.map((resource) => (
                <option key={resource} value={resource}>
                  {resourceLabel(resource)}
                </option>
              ))}
            </select>
            <button
              className="secondary-action"
              disabled={!isMyTurn || state.phase !== "playing" || !state.hasRolled}
              onClick={() =>
                socket.emit("game:action", {
                  type: "catan:bank-trade",
                  give: tradeGive,
                  receive: tradeReceive
                })
              }
            >
              4:1 交换
            </button>
          </div>

          <button
            className="secondary-action"
            disabled={
              !isMyTurn ||
              state.phase !== "playing" ||
              !state.hasRolled ||
              state.needsRobberMove
            }
            onClick={() => socket.emit("game:action", { type: "catan:end-turn" })}
          >
            结束回合
          </button>
        </div>
      </div>

      <div className="catan-score-grid">
        {room.players.map((player) => {
          const playerState = state.playerStates[player.id];
          return (
            <div className="catan-score-card" key={player.id}>
              <span style={{ background: player.color }}>{initialOf(player.name)}</span>
              <div>
                <strong>{player.name}</strong>
                <small>
                  {playerState?.victoryPoints || 0} 分 · 路 {playerState?.roads || 0} · 村{" "}
                  {playerState?.settlements || 0} · 城 {playerState?.cities || 0}
                </small>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkipVotePanel({
  room,
  playerId,
  socket,
  skipVote
}: {
  room: RoomView;
  playerId: string;
  socket: Socket;
  skipVote: SkipVoteState;
}) {
  const target = room.players.find((player) => player.id === skipVote.targetPlayerId);
  const yesCount = Object.values(skipVote.votes).filter((vote) => vote === "yes").length;
  const noCount = Object.values(skipVote.votes).filter((vote) => vote === "no").length;
  const requiredCount = skipVote.eligiblePlayerIds.length;
  const myVote = skipVote.votes[playerId];
  const canVote = skipVote.eligiblePlayerIds.includes(playerId) && !myVote;

  return (
    <div className="skip-vote-panel">
      <div>
        <span className="panel-kicker">超时投票</span>
        <strong>是否跳过 {target?.name || "当前玩家"}？</strong>
        <p>需要其他在场玩家全部同意；有人不同意，就给当前玩家重新 2 分钟。</p>
        <small>
          已同意 {yesCount}/{requiredCount}
          {noCount > 0 ? `，不同意 ${noCount}` : ""}
          {myVote ? `，你已选择${myVote === "yes" ? "同意" : "不同意"}` : ""}
        </small>
      </div>
      <div className="skip-vote-actions">
        <button
          className="primary-action"
          disabled={!canVote}
          onClick={() => socket.emit("game:action", { type: "skip:vote", vote: "yes" })}
        >
          <Check size={18} />
          同意跳过
        </button>
        <button
          className="secondary-action"
          disabled={!canVote}
          onClick={() => socket.emit("game:action", { type: "skip:vote", vote: "no" })}
        >
          <RefreshCw size={18} />
          不同意
        </button>
      </div>
    </div>
  );
}

function AvatarFigure({
  avatarUrl,
  fallback,
  className = ""
}: {
  avatarUrl: string;
  fallback: string;
  className?: string;
}) {
  const preset = getAvatarPreset(avatarUrl);

  if (!preset) {
    return <span className={`fallback-initial ${className}`.trim()}>{fallback}</span>;
  }

  const style = {
    "--avatar-primary": preset.primary,
    "--avatar-secondary": preset.secondary
  } as CSSProperties;

  return (
    <span
      aria-label={`${preset.name}头像`}
      className={`preset-avatar ${className}`.trim()}
      style={style}
      title={preset.name}
    >
      <span className="preset-avatar-mark">{preset.mark}</span>
    </span>
  );
}

function HomeAccountMenu({
  displayName,
  avatarUrl,
  email,
  isSignedIn,
  menuOpen,
  onToggle,
  onAuthOpen,
  onSelect,
  onSignOut
}: {
  displayName: string;
  avatarUrl: string;
  email: string;
  isSignedIn: boolean;
  menuOpen: boolean;
  onToggle: () => void;
  onAuthOpen: (mode?: "signin" | "signup") => void;
  onSelect: (view: Exclude<AccountPanelView, null>) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="home-account-menu">
      <button
        className={isSignedIn ? "account-avatar-button signed-in" : "account-avatar-button"}
        type="button"
        aria-expanded={menuOpen}
        onClick={isSignedIn ? onToggle : () => onAuthOpen("signin")}
      >
        {isSignedIn ? (
          <AvatarFigure avatarUrl={avatarUrl} fallback={initialOf(displayName)} />
        ) : (
          <UserRound size={20} />
        )}
      </button>
      {!isSignedIn && (
        <button className="auth-open-button" type="button" onClick={() => onAuthOpen("signin")}>
          登录/注册
        </button>
      )}

      {menuOpen && isSignedIn && (
        <div className="account-dropdown">
          <div className="account-dropdown-head">
            <strong>{isSignedIn ? displayName : "未登录"}</strong>
            <small>{isSignedIn ? email : "登录后可创建和加入房间"}</small>
          </div>
          <button type="button" onClick={() => onSelect("details")}>
            <UserRound size={18} />
            详细资料
          </button>
          <button type="button" onClick={() => onSelect("security")}>
            <ShieldCheck size={18} />
            账号安全
          </button>
          {isSignedIn && (
            <button className="danger" type="button" onClick={onSignOut}>
              <LogOut size={18} />
              退出登录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AccountPage({
  view,
  configured,
  session,
  displayName,
  avatarUrl,
  honorText,
  email,
  password,
  signupCode,
  signupCodeSent,
  signupCodeCooldown,
  sendingSignupCode,
  submitting,
  records,
  authMode,
  notice,
  onClose,
  onNameChange,
  onAvatarChange,
  onHonorTextChange,
  onProfileSave,
  onSignOut,
  onAuthModeChange,
  onEmailChange,
  onPasswordChange,
  onSignupCodeChange,
  onRequestSignupCode,
  onAuthSubmit
}: {
  view: Exclude<AccountPanelView, null>;
  configured: boolean;
  session: Session | null;
  displayName: string;
  avatarUrl: string;
  honorText: string;
  email: string;
  password: string;
  signupCode: string;
  signupCodeSent: boolean;
  signupCodeCooldown: number;
  sendingSignupCode: boolean;
  submitting: boolean;
  records: GameRecord[];
  authMode: "signin" | "signup";
  notice: Notice | null;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onHonorTextChange: (value: string) => void;
  onProfileSave: () => void;
  onSignOut: () => void;
  onAuthModeChange: (mode: "signin" | "signup") => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignupCodeChange: (value: string) => void;
  onRequestSignupCode: () => void;
  onAuthSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="app-shell account-page-shell">
      <button className="icon-text-button back-button" type="button" onClick={onClose}>
        <ArrowLeft size={18} />
        返回首页
      </button>

      <section className="account-page-hero">
        <div className="account-page-avatar">
          {session ? (
            <AvatarFigure avatarUrl={avatarUrl} fallback={initialOf(displayName || "新玩家")} />
          ) : (
            <UserRound size={34} />
          )}
        </div>
        <div>
          <span className="panel-kicker">账号中心</span>
          <h1>{view === "details" ? "详细资料" : "账号安全"}</h1>
          <p>{session ? session.user.email || "已登录账号" : "登录后可创建和加入房间"}</p>
        </div>
      </section>

      {notice && <NoticeBar notice={notice} />}

      <section className="panel account-page-panel">
        {session ? (
          view === "details" ? (
            <ProfilePanel
              name={displayName}
              avatarUrl={avatarUrl}
              honorText={honorText}
              email={session.user.email || ""}
              records={records}
              onNameChange={onNameChange}
              onAvatarChange={onAvatarChange}
              onHonorTextChange={onHonorTextChange}
              onSave={onProfileSave}
              onSignOut={onSignOut}
            />
          ) : (
            <div className="security-panel">
              <div className="security-row">
                <span>登录邮箱</span>
                <strong>{session.user.email || "未绑定邮箱"}</strong>
              </div>
              <div className="security-row">
                <span>登录保护</span>
                <strong>密码输错 6 次，当天不能再登录</strong>
              </div>
              <div className="security-row">
                <span>账号状态</span>
                <strong>已登录，创建和加入房间已开启</strong>
              </div>
              <p className="hint">
                为了保护账号，密码不会显示在网页里。忘记密码时，后续可以接 Supabase 邮件重置流程。
              </p>
              <button className="icon-text-button danger" type="button" onClick={onSignOut}>
                <LogOut size={18} />
                退出登录
              </button>
            </div>
          )
        ) : (
          <AuthPanel
            configured={configured}
            mode={authMode}
            email={email}
            password={password}
            signupCode={signupCode}
            signupCodeSent={signupCodeSent}
            signupCodeCooldown={signupCodeCooldown}
            sendingSignupCode={sendingSignupCode}
            submitting={submitting}
            onModeChange={onAuthModeChange}
            onEmailChange={onEmailChange}
            onPasswordChange={onPasswordChange}
            onSignupCodeChange={onSignupCodeChange}
            onRequestSignupCode={onRequestSignupCode}
            onSubmit={onAuthSubmit}
          />
        )}
      </section>
    </main>
  );
}

function AuthDialog({
  configured,
  mode,
  email,
  password,
  signupCode,
  signupCodeSent,
  signupCodeCooldown,
  sendingSignupCode,
  submitting,
  onClose,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSignupCodeChange,
  onRequestSignupCode,
  onSubmit
}: {
  configured: boolean;
  mode: "signin" | "signup";
  email: string;
  password: string;
  signupCode: string;
  signupCodeSent: boolean;
  signupCodeCooldown: number;
  sendingSignupCode: boolean;
  submitting: boolean;
  onClose: () => void;
  onModeChange: (mode: "signin" | "signup") => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignupCodeChange: (value: string) => void;
  onRequestSignupCode: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="auth-dialog-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby="auth-dialog-title"
        aria-modal="true"
        className="auth-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="auth-dialog-head">
          <div>
            <span className="panel-kicker">账号入口</span>
            <h2 id="auth-dialog-title">{mode === "signup" ? "注册账号" : "登录账号"}</h2>
          </div>
          <button className="icon-text-button" type="button" onClick={onClose}>
            <X size={18} />
            关闭
          </button>
        </div>
        <AuthPanel
          configured={configured}
          mode={mode}
          email={email}
          password={password}
          signupCode={signupCode}
          signupCodeSent={signupCodeSent}
          signupCodeCooldown={signupCodeCooldown}
          sendingSignupCode={sendingSignupCode}
          submitting={submitting}
          onModeChange={onModeChange}
          onEmailChange={onEmailChange}
          onPasswordChange={onPasswordChange}
          onSignupCodeChange={onSignupCodeChange}
          onRequestSignupCode={onRequestSignupCode}
          onSubmit={onSubmit}
        />
      </section>
    </div>
  );
}

function AuthPanel({
  configured,
  mode,
  email,
  password,
  signupCode,
  signupCodeSent,
  signupCodeCooldown,
  sendingSignupCode,
  submitting,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSignupCodeChange,
  onRequestSignupCode,
  onSubmit
}: {
  configured: boolean;
  mode: "signin" | "signup";
  email: string;
  password: string;
  signupCode: string;
  signupCodeSent: boolean;
  signupCodeCooldown: number;
  sendingSignupCode: boolean;
  submitting: boolean;
  onModeChange: (mode: "signin" | "signup") => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSignupCodeChange: (value: string) => void;
  onRequestSignupCode: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const canSendSignupCode = configured && !sendingSignupCode && signupCodeCooldown <= 0;

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <p className="hint">
        {configured && mode === "signup"
          ? "注册需要邮箱验证码，验证成功后才会创建并登录账号。"
          : configured
            ? "必须登录后才能创建、加入房间，并保存昵称和战绩。"
            : "当前未配置 Supabase，账号系统不可用，暂时不能进入房间。"}
      </p>
      <div className="segmented">
        <button
          type="button"
          className={mode === "signin" ? "active" : ""}
          onClick={() => onModeChange("signin")}
        >
          登录
        </button>
        <button
          type="button"
          className={mode === "signup" ? "active" : ""}
          onClick={() => onModeChange("signup")}
        >
          注册
        </button>
      </div>
      <label className="field">
        <span>邮箱</span>
        <input
          type="email"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          disabled={!configured}
          placeholder="you@example.com"
        />
      </label>
      <label className="field">
        <span>密码</span>
        <input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          disabled={!configured}
          placeholder="至少 6 位"
        />
      </label>
      {mode === "signup" && (
        <div className="code-row">
          <label className="field">
            <span>邮箱验证码</span>
            <input
              inputMode="numeric"
              value={signupCode}
              onChange={(event) =>
                onSignupCodeChange(event.target.value.replace(/\D/g, "").slice(0, 8))
              }
              disabled={!configured}
              placeholder={signupCodeSent ? "输入邮箱里的验证码" : "先发送验证码"}
            />
          </label>
          <button
            className="icon-text-button code-send-button"
            disabled={!canSendSignupCode}
            onClick={onRequestSignupCode}
            type="button"
          >
            {sendingSignupCode
              ? "发送中"
              : signupCodeCooldown > 0
                ? `${signupCodeCooldown} 秒`
                : signupCodeSent
                  ? "重新发送"
                  : "发送验证码"}
          </button>
        </div>
      )}
      <button className="secondary-action" disabled={!configured || submitting} type="submit">
        <KeyRound size={19} />
        {submitting ? "处理中" : mode === "signin" ? "登录账号" : "验证并注册"}
      </button>
    </form>
  );
}

function ProfilePanel({
  name,
  avatarUrl,
  honorText,
  email,
  records,
  onNameChange,
  onAvatarChange,
  onHonorTextChange,
  onSave,
  onSignOut
}: {
  name: string;
  avatarUrl: string;
  honorText: string;
  email: string;
  records: GameRecord[];
  onNameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onHonorTextChange: (value: string) => void;
  onSave: () => void;
  onSignOut: () => void;
}) {
  const totalGames = records.length;
  const wins = records.filter((record) => record.result === "win").length;
  const draws = records.filter((record) => record.result === "draw").length;
  const winRate = totalGames ? Math.round((wins / totalGames) * 100) : 0;

  return (
    <div className="profile-panel">
      <div className="profile-edit-grid">
        <div className="avatar-editor">
          <div className="avatar-preview">
            <AvatarFigure avatarUrl={avatarUrl} fallback={initialOf(name || "新玩家")} />
          </div>
          <div className="avatar-actions">
            <p className="avatar-helper">从 16 个官方头像中选择，不支持自定义上传。</p>
            <div className="avatar-preset-grid" role="radiogroup" aria-label="选择头像">
              {AVATAR_PRESETS.map((preset) => (
                <button
                  aria-checked={avatarUrl === preset.value}
                  className={
                    avatarUrl === preset.value
                      ? "avatar-preset-option selected"
                      : "avatar-preset-option"
                  }
                  key={preset.value}
                  onClick={() => onAvatarChange(preset.value)}
                  title={preset.name}
                  type="button"
                  role="radio"
                >
                  <AvatarFigure avatarUrl={preset.value} fallback={preset.mark} />
                </button>
              ))}
            </div>
            {avatarUrl && (
              <button className="icon-text-button" type="button" onClick={() => onAvatarChange("")}>
                不使用头像
              </button>
            )}
          </div>
        </div>

        <div className="profile-fields">
          <label className="field">
            <span>显示昵称</span>
            <input
              value={name}
              maxLength={18}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="例如：新玩家"
            />
          </label>
          <label className="field">
            <span>荣誉介绍</span>
            <textarea
              value={honorText}
              maxLength={180}
              onChange={(event) => onHonorTextChange(event.target.value)}
              placeholder="写一句你的桌游宣言、擅长游戏或获胜荣誉"
            />
          </label>
        </div>
      </div>

      <div className="profile-actions">
        <button className="secondary-action" onClick={onSave}>
          <Check size={19} />
          保存资料
        </button>
        <button className="icon-text-button" onClick={onSignOut}>
          <LogOut size={18} />
          退出
        </button>
      </div>
      <p className="hint">{email}</p>

      <div className="profile-summary-grid">
        <div>
          <span>总局数</span>
          <strong>{totalGames}</strong>
        </div>
        <div>
          <span>胜场</span>
          <strong>{wins}</strong>
        </div>
        <div>
          <span>平局</span>
          <strong>{draws}</strong>
        </div>
        <div>
          <span>胜率</span>
          <strong>{winRate}%</strong>
        </div>
      </div>

      <div className="section-heading-inline">
        <Trophy size={19} />
        <strong>游戏记录</strong>
      </div>
      <div className="record-list">
        {records.length === 0 ? (
          <p className="hint">暂无战绩，玩一局后会出现在这里。</p>
        ) : (
          records.map((record) => (
            <div key={record.id} className="record-row">
              <div>
                <span>{GAME_META[record.game_type].name}</span>
                <small>{new Date(record.created_at).toLocaleDateString("zh-CN")}</small>
              </div>
              <strong className={`record-result ${record.result}`}>
                {record.result === "win" ? "胜" : record.result === "loss" ? "负" : "平"}
              </strong>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  return <div className={`notice ${notice.tone}`}>{notice.text}</div>;
}

function getSessionPlayerId() {
  const key = "board-room-player-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;

  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `player_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(key, id);
  return id;
}

function normalizeRoomCode(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function isLikelyEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const catanResourceOrder: CatanResource[] = ["wood", "brick", "sheep", "wheat", "ore"];

function resourceLabel(resource: CatanResource) {
  const labels: Record<CatanResource, string> = {
    wood: "木",
    brick: "砖",
    sheep: "羊",
    wheat: "麦",
    ore: "矿"
  };
  return labels[resource];
}

function terrainLabel(terrain: CatanTerrain) {
  const labels: Record<CatanTerrain, string> = {
    forest: "森林",
    hill: "丘陵",
    pasture: "牧场",
    field: "麦田",
    mountain: "山地",
    desert: "沙漠"
  };
  return labels[terrain];
}

function catanPolygonPoints(x: number, y: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (30 + 60 * index);
    return `${roundViewCoord(x + Math.cos(angle))},${roundViewCoord(y + Math.sin(angle))}`;
  }).join(" ");
}

function catanViewBox(state: CatanPublicState) {
  const xs = [
    ...state.hexes.map((hex) => hex.x),
    ...state.vertices.map((vertex) => vertex.x)
  ];
  const ys = [
    ...state.hexes.map((hex) => hex.y),
    ...state.vertices.map((vertex) => vertex.y)
  ];
  const minX = Math.min(...xs) - 0.7;
  const maxX = Math.max(...xs) + 0.7;
  const minY = Math.min(...ys) - 0.7;
  const maxY = Math.max(...ys) + 0.7;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

function roundViewCoord(value: number) {
  return Math.round(value * 1000) / 1000;
}

function useCountdown(endsAt?: number) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!endsAt) {
      setNow(Date.now());
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endsAt]);

  return Math.max(0, (endsAt || 0) - now);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function initialOf(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "玩";
}

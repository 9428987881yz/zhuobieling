import {
  CSSProperties,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Check,
  CircleDot,
  Copy,
  Crown,
  Dice6,
  DoorOpen,
  Eye,
  EyeOff,
  Gamepad2,
  KeyRound,
  LogOut,
  Play,
  QrCode,
  RefreshCw,
  Send,
  Sparkles,
  UserPlus,
  Users,
  Wifi,
  WifiOff
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { io, Socket } from "socket.io-client";
import type { Session } from "@supabase/supabase-js";
import {
  GAME_META,
  GameType,
  GomokuPublicState,
  LudoPublicState,
  Player,
  PublicGameState,
  RoomView,
  UndercoverPublicState
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

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);

const BRAND_NAME = "桌别零";
const initialInviteCode = normalizeRoomCode(
  new URLSearchParams(window.location.search).get("room") || ""
);
const playerId = getSessionPlayerId();

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
  const [session, setSession] = useState<Session | null>(null);
  const [profileName, setProfileName] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [records, setRecords] = useState<GameRecord[]>([]);

  const socket = useMemo(
    () =>
      io(socketUrl, {
        transports: ["websocket", "polling"]
      }),
    []
  );

  const displayName = (profileName || guestName || "新玩家").trim();
  const authProfile = session?.user
    ? {
        userId: session.user.id,
        name: displayName
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
      autoJoinAttemptedRef.current
    ) {
      return;
    }

    autoJoinAttemptedRef.current = true;
    socket.emit("room:join", {
      code: initialInviteCode,
      playerId,
      playerName: displayName || "新玩家",
      profile: authProfile
    });
    setNotice({
      tone: "info",
      text: `正在加入房间 ${initialInviteCode}...`
    });
  }, [authProfile, displayName, room, socket, socketConnected]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) {
        void loadProfile(data.session.user.id);
      }
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        void loadProfile(nextSession.user.id);
      } else {
        setProfileName("");
        setRecords([]);
      }
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user || !supabase) return;
    void loadRecords(session.user.id);
  }, [session?.user?.id]);

  async function loadProfile(userId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      setNotice({ tone: "error", text: "读取个人资料失败，请检查 Supabase 配置。" });
      return;
    }

    const nextName = data?.display_name || guestName;
    setProfileName(nextName);
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

    const result =
      authMode === "signup"
        ? await supabase.auth.signUp({
            email: cleanEmail,
            password,
            options: { data: { display_name: displayName } }
          })
        : await supabase.auth.signInWithPassword({
            email: cleanEmail,
            password
          });

    if (result.error) {
      setNotice({ tone: "error", text: result.error.message });
      return;
    }

    if (result.data.user) {
      await upsertProfile(result.data.user.id, displayName);
    }

    setNotice({
      tone: "success",
      text: authMode === "signup" ? "账号已创建。" : "已登录。"
    });
  }

  async function upsertProfile(userId: string, name: string) {
    if (!supabase) return;
    const cleanName = name.trim() || "新玩家";
    const { error } = await supabase.from("profiles").upsert({
      id: userId,
      display_name: cleanName,
      updated_at: new Date().toISOString()
    });

    if (error) {
      setNotice({ tone: "error", text: "保存个人资料失败。" });
      return;
    }

    setProfileName(cleanName);
    setGuestName(cleanName);
  }

  function createRoom() {
    const playerName = displayName || "新玩家";
    socket.emit("room:create", {
      playerId,
      playerName,
      gameType: selectedGame,
      profile: authProfile
    });
  }

  function joinRoom(event?: FormEvent) {
    event?.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      setNotice({ tone: "error", text: "请输入房间号。" });
      return;
    }

    socket.emit("room:join", {
      code,
      playerId,
      playerName: displayName || "新玩家",
      profile: authProfile
    });
  }

  function leaveRoom() {
    socket.emit("room:leave");
    setRoom(null);
    localStorage.removeItem("board-room-last-room");
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
      />
    );
  }

  return (
    <main className="app-shell">
      <section className="hero-band">
        <div className="hero-copy">
          <div className="brand-lockup">
            <img className="brand-mark" src={brandLogoUrl} alt="桌别零图形标识" />
            <div>
              <div className="eyebrow">
                <Gamepad2 size={16} />
                在线桌游从零开局
              </div>
              <h1>{BRAND_NAME}</h1>
            </div>
          </div>
          <p>
            输入昵称、创建房间，把 6 位房间号发给朋友，就能在桌别零一起开一桌。
          </p>
        </div>
        <div className={socketConnected ? "status online" : "status offline"}>
          {socketConnected ? <Wifi size={18} /> : <WifiOff size={18} />}
          {socketConnected ? "实时服务器已连接" : "正在连接服务器"}
        </div>
      </section>

      {notice && <NoticeBar notice={notice} />}

      <section className="dashboard-grid">
        <div className="panel command-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">开局</span>
              <h2>创建房间</h2>
            </div>
            <Sparkles size={22} />
          </div>

          <label className="field">
            <span>你的昵称</span>
            <input
              value={displayName}
              maxLength={18}
              onChange={(event) => {
                setGuestName(event.target.value);
                if (session?.user) setProfileName(event.target.value);
              }}
              placeholder="例如：小明"
            />
          </label>

          <GamePicker selected={selectedGame} onSelect={setSelectedGame} />

          <button className="primary-action" onClick={createRoom}>
            <DoorOpen size={20} />
            创建新房间
          </button>
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
              加入房间
            </button>
          </form>
        </div>

        <div className="panel account-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">账号</span>
              <h2>{session ? "个人资料" : "游客也能玩"}</h2>
            </div>
            <KeyRound size={22} />
          </div>

          {session ? (
            <ProfilePanel
              name={profileName || guestName}
              email={session.user.email || ""}
              records={records}
              onNameChange={setProfileName}
              onSave={() => void upsertProfile(session.user.id, profileName)}
              onSignOut={() => void supabase?.auth.signOut()}
            />
          ) : (
            <AuthPanel
              configured={isSupabaseConfigured}
              mode={authMode}
              email={email}
              password={password}
              onModeChange={setAuthMode}
              onEmailChange={setEmail}
              onPasswordChange={setPassword}
              onSubmit={handleAuth}
            />
          )}
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
  notice
}: {
  room: RoomView;
  playerId: string;
  socket: Socket;
  onLeave: () => void;
  onNotice: (notice: Notice) => void;
  socketConnected: boolean;
  notice: Notice | null;
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
  const activePlayers = room.players.filter(
    (player) => !state.eliminatedIds.includes(player.id)
  );
  const isEliminated = state.eliminatedIds.includes(playerId);
  const canAdvance =
    room.hostId === playerId || state.currentSpeakerId === playerId;
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
              disabled={isEliminated || Boolean(state.votes[playerId])}
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
  const [now, setNow] = useState(Date.now());
  const current = room.players.find((player) => player.id === state.currentPlayerId);
  const winner = room.players.find((player) => player.id === state.winnerId);
  const timeoutLoser = room.players.find(
    (player) => player.id === state.timeoutLoserId
  );
  const myStone = state.playerStones[playerId];
  const isMyTurn = state.currentPlayerId === playerId;
  const canSelectMove = isMyTurn && !state.winnerId && !state.isDraw && Boolean(myStone);
  const timeLeftMs = Math.max(0, (state.turnEndsAt || 0) - now);
  const timePercent = state.turnDurationMs
    ? Math.max(0, Math.min(100, (timeLeftMs / state.turnDurationMs) * 100))
    : 0;
  const winningSet = new Set(
    state.winningLine?.map(([x, y]) => `${x}:${y}`) || []
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

      <div className="dice-panel">
        <button
          className="primary-action"
          disabled={state.currentPlayerId !== playerId || Boolean(state.winnerId)}
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

function AuthPanel({
  configured,
  mode,
  email,
  password,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSubmit
}: {
  configured: boolean;
  mode: "signin" | "signup";
  email: string;
  password: string;
  onModeChange: (mode: "signin" | "signup") => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <p className="hint">
        {configured
          ? "登录后会保存昵称和战绩。"
          : "当前未配置 Supabase，仍可用游客模式联机。"}
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
      <button className="secondary-action" disabled={!configured} type="submit">
        <KeyRound size={19} />
        {mode === "signin" ? "登录账号" : "创建账号"}
      </button>
    </form>
  );
}

function ProfilePanel({
  name,
  email,
  records,
  onNameChange,
  onSave,
  onSignOut
}: {
  name: string;
  email: string;
  records: GameRecord[];
  onNameChange: (value: string) => void;
  onSave: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="profile-panel">
      <label className="field">
        <span>显示昵称</span>
        <input
          value={name}
          maxLength={18}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <div className="profile-actions">
        <button className="secondary-action" onClick={onSave}>
          <Check size={19} />
          保存
        </button>
        <button className="icon-text-button" onClick={onSignOut}>
          <LogOut size={18} />
          退出
        </button>
      </div>
      <p className="hint">{email}</p>
      <div className="record-list">
        {records.length === 0 ? (
          <p className="hint">暂无战绩，玩一局后会出现在这里。</p>
        ) : (
          records.map((record) => (
            <div key={record.id} className="record-row">
              <span>{GAME_META[record.game_type].name}</span>
              <strong>
                {record.result === "win"
                  ? "胜"
                  : record.result === "loss"
                    ? "负"
                    : "平"}
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

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function initialOf(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "玩";
}

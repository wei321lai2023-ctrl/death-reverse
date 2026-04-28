import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { io } from "socket.io-client";
import { Bot, Copy, Crown, EyeOff, Play, RotateCcw, Skull, UserMinus, Users } from "lucide-react";
import "./styles.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:3001`;

function getPlayerId() {
  const existing = localStorage.getItem("deathReversePlayerId");
  if (existing) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem("deathReversePlayerId", next);
  return next;
}

function App() {
  const [socket, setSocket] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(localStorage.getItem("deathReverseName") || "");
  const [roomCode, setRoomCode] = useState(localStorage.getItem("deathReverseRoom") || "");
  const playerId = useMemo(getPlayerId, []);

  useEffect(() => {
    const nextSocket = io(SERVER_URL, { transports: ["websocket"] });
    setSocket(nextSocket);

    nextSocket.on("roomCreated", ({ code }) => {
      localStorage.setItem("deathReverseRoom", code);
      setRoomCode(code);
    });
    nextSocket.on("roomState", (nextState) => {
      setState(nextState);
      setError("");
      localStorage.setItem("deathReverseRoom", nextState.code);
    });
    nextSocket.on("leftRoom", () => {
      localStorage.removeItem("deathReverseRoom");
      setState(null);
      setRoomCode("");
      setError("");
    });
    nextSocket.on("gameError", setError);

    const savedRoom = localStorage.getItem("deathReverseRoom");
    const savedName = localStorage.getItem("deathReverseName");
    if (savedRoom && savedName) {
      nextSocket.emit("joinRoom", { code: savedRoom, name: savedName, playerId });
    }

    return () => nextSocket.disconnect();
  }, [playerId]);

  function rememberName(value) {
    setName(value);
    localStorage.setItem("deathReverseName", value);
  }

  function createRoom() {
    socket.emit("createRoom", { name, playerId });
  }

  function joinRoom() {
    socket.emit("joinRoom", { code: roomCode, name, playerId });
  }

  function leaveRoom() {
    if (state?.code) socket.emit("leaveRoom", { code: state.code });
    localStorage.removeItem("deathReverseRoom");
    setState(null);
    setRoomCode("");
  }

  if (!state) {
    return (
      <Shell error={error}>
        <Home name={name} setName={rememberName} roomCode={roomCode} setRoomCode={setRoomCode} onCreate={createRoom} onJoin={joinRoom} />
      </Shell>
    );
  }

  return (
    <Shell error={error}>
      {state.phase === "lobby" && <Lobby state={state} socket={socket} onLeave={leaveRoom} />}
      {["prediction", "trick", "trickResult", "roundEnd"].includes(state.phase) && <Game state={state} socket={socket} onLeave={leaveRoom} />}
      {state.phase === "gameOver" && <FinalResults state={state} socket={socket} />}
    </Shell>
  );
}

function Shell({ children, error }) {
  return (
    <main className="min-h-screen bg-stone-100 text-stone-950">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5">
        <header className="mb-4 flex items-center justify-between border-b border-stone-300 pb-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Death Reverse</h1>
            <p className="text-sm text-stone-600">5 players · 9 rounds · no mercy for bad predictions</p>
          </div>
          <div className="rounded bg-stone-900 px-3 py-1 text-sm font-semibold text-white">MVP</div>
        </header>
        {error && <div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {children}
      </div>
    </main>
  );
}

function Home({ name, setName, roomCode, setRoomCode, onCreate, onJoin }) {
  const canAct = name.trim().length > 0;
  return (
    <section className="mx-auto mt-12 w-full max-w-md">
      <div className="space-y-4 rounded border border-stone-300 bg-white p-5 shadow-sm">
        <label className="block">
          <span className="text-sm font-medium text-stone-700">Your name</span>
          <input className="mt-1 input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} placeholder="Alice" />
        </label>
        <button className="primary-btn w-full" disabled={!canAct} onClick={onCreate}>
          <Users size={18} /> Create room
        </button>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input className="input uppercase" value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="Room code" />
          <button className="secondary-btn" disabled={!canAct || !roomCode.trim()} onClick={onJoin}>
            Join
          </button>
        </div>
      </div>
    </section>
  );
}

function Lobby({ state, socket, onLeave }) {
  const me = state.players[state.mySeat];
  const ready = Boolean(me?.ready);
  const emptySeats = state.players.filter((player) => player.empty).length;
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div>
        <RoomCode code={state.code} onLeave={onLeave} />
        <SeatGrid players={state.players} scores={state.scores} mySeat={state.mySeat} isOwner={state.isOwner} onRemoveBot={(seat) => socket.emit("removeBot", { code: state.code, seat })} />
      </div>
      <aside className="rounded border border-stone-300 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">Lobby</h2>
        <p className="mb-4 text-sm text-stone-600">Game starts automatically when all 5 seats are filled and ready.</p>
        {state.isOwner && emptySeats > 0 && (
          <button className="secondary-btn mb-3 w-full" onClick={() => socket.emit("addBot", { code: state.code })}>
            <Bot size={18} /> Add bot
          </button>
        )}
        <button className={ready ? "secondary-btn w-full" : "primary-btn w-full"} onClick={() => socket.emit("setReady", { code: state.code, ready: !ready })}>
          <Play size={18} /> {ready ? "Not ready" : "Ready"}
        </button>
      </aside>
    </section>
  );
}

function RoomCode({ code, onLeave }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded border border-stone-300 bg-white p-3">
      <span className="text-sm text-stone-600">Room</span>
      <strong className="text-xl tracking-widest">{code}</strong>
      <button className="icon-btn" title="Copy room code" onClick={() => navigator.clipboard.writeText(code)}>
        <Copy size={17} />
      </button>
      {onLeave && (
        <button className="secondary-btn ml-auto" onClick={onLeave}>
          Leave room
        </button>
      )}
    </div>
  );
}

function Game({ state, socket, onLeave }) {
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <RoomCode code={state.code} onLeave={onLeave} />
        <StatusBar state={state} />
        {state.phase === "prediction" && <PredictionPanel state={state} socket={socket} />}
        {["trick", "trickResult"].includes(state.phase) && <Table state={state} />}
        {state.phase === "trickResult" && <TrickResult state={state} socket={socket} />}
        {state.phase === "roundEnd" && <RoundSummary state={state} />}
        {state.phase === "roundEnd" && <ContinuePanel state={state} socket={socket} label="Start next round" />}
        <Hand state={state} socket={socket} />
      </div>
      <aside className="space-y-4">
        <Scoreboard state={state} />
        <PredictionList state={state} />
        <TrickHistory state={state} />
      </aside>
    </section>
  );
}

function StatusBar({ state }) {
  const current = state.players[state.currentTurnSeat]?.name || "-";
  const leader = state.players[state.leaderSeat]?.name || "-";
  const phaseLabel = state.phase === "trickResult" ? "Review" : state.phase === "roundEnd" ? "Round result" : state.phase;
  return (
    <div className="grid gap-2 rounded border border-stone-300 bg-white p-3 sm:grid-cols-5">
      <Metric label="Round" value={`${state.round} / 9`} />
      <Metric label="Trick" value={`${state.trickNumber || 1} / ${state.round || 1}`} />
      <Metric label="State" value={phaseLabel} />
      <Metric label="Turn" value={current} />
      <Metric label="Leader" value={leader} />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase text-stone-500">{label}</div>
      <div className="truncate font-semibold">{value}</div>
    </div>
  );
}

function PredictionPanel({ state, socket }) {
  const [value, setValue] = useState(0);
  const [hidden, setHidden] = useState(false);
  const me = state.players[state.mySeat];
  const alreadySubmitted = Boolean(state.predictions[state.mySeat]);

  useEffect(() => {
    setValue(0);
    setHidden(false);
  }, [state.round]);

  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Predict your wins</h2>
      <p className="mb-3 text-sm text-stone-600">Look at your hand first, then choose your prediction.</p>
      {alreadySubmitted ? (
        <p className="text-sm text-stone-600">Prediction submitted. Waiting for everyone else.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <select className="input max-w-28" value={value} onChange={(event) => setValue(Number(event.target.value))}>
            {Array.from({ length: state.round + 1 }, (_, option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <label className={`flex items-center gap-2 text-sm ${me?.hiddenUsed ? "text-stone-400" : "text-stone-700"}`}>
            <input type="checkbox" disabled={me?.hiddenUsed} checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
            Hide this prediction
          </label>
          <button className="primary-btn" onClick={() => socket.emit("submitPrediction", { code: state.code, value, hidden })}>
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

function Table({ state }) {
  const resultMode = state.phase === "trickResult" && state.lastTrick;
  const played = resultMode ? state.lastTrick.played : state.played;
  const order = resultMode
    ? played.map((entry) => entry.seat)
    : state.leaderSeat === null
      ? [0, 1, 2, 3, 4]
      : [0, 1, 2, 3, 4].sort((a, b) => relativeSeat(a, state.leaderSeat) - relativeSeat(b, state.leaderSeat));
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">{resultMode ? `Trick ${state.lastTrick.trickNumber} result` : "Table"}</h2>
      <div className="grid min-h-48 gap-3 sm:grid-cols-5">
        {order.map((seat) => {
          const play = played.find((entry) => entry.seat === seat);
          const won = resultMode && state.lastTrick.winnerSeat === seat;
          return (
            <div key={seat} className={`rounded border p-3 ${won ? "border-green-600 bg-green-50" : state.currentTurnSeat === seat ? "border-stone-900 bg-amber-50" : "border-stone-200"}`}>
              <div className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
                <span className="truncate">{state.players[seat]?.name || `Seat ${seat + 1}`}</span>
                {won && <span className="rounded bg-green-700 px-2 py-0.5 text-xs font-bold text-white">Won</span>}
              </div>
              {play ? <Card card={play.card} /> : <div className="flex h-24 items-center justify-center rounded border border-dashed border-stone-300 text-sm text-stone-400">Waiting</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relativeSeat(seat, leaderSeat) {
  return (seat - leaderSeat + 5) % 5;
}

function Hand({ state, socket }) {
  if (state.phase === "roundEnd") return null;
  const canPlay = state.currentTurnSeat === state.mySeat;
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Your hand</h2>
      <div className="flex flex-wrap gap-2">
        {state.hand.map((card) => (
          <button key={card.id} className="card-button" disabled={!canPlay} onClick={() => socket.emit("playCard", { code: state.code, cardId: card.id })}>
            <Card card={card} />
          </button>
        ))}
      </div>
      {!canPlay && <p className="mt-2 text-sm text-stone-500">{state.phase === "prediction" ? "Use these cards to make your prediction." : state.phase === "trickResult" ? "Review the trick result, then continue." : "Waiting for your turn."}</p>}
    </div>
  );
}

function TrickResult({ state, socket }) {
  if (!state.lastTrick) return null;
  const winner = state.players[state.lastTrick.winnerSeat]?.name || `Seat ${state.lastTrick.winnerSeat + 1}`;
  return (
    <div className="rounded border border-green-300 bg-green-50 p-4">
      <h2 className="mb-2 text-lg font-semibold">Winner: {winner}</h2>
      <p className="mb-3 text-sm text-green-900">Everyone can review the played cards before the next trick starts.</p>
      <ContinuePanel state={state} socket={socket} label={state.trickNumber >= state.round ? "Show round score" : "Next trick"} />
    </div>
  );
}

function ContinuePanel({ state, socket, label }) {
  const humanSeats = state.players.filter((player) => !player.empty && !player.isBot && player.connected).map((player) => player.seat);
  const readyCount = humanSeats.filter((seat) => state.continueVotes?.[seat]).length;
  const alreadyReady = Boolean(state.continueVotes?.[state.mySeat]);
  const waitingNames = humanSeats.filter((seat) => !state.continueVotes?.[seat]).map((seat) => state.players[seat]?.name || `Seat ${seat + 1}`);
  const [now, setNow] = useState(Date.now());
  const secondsLeft = state.continueDeadlineAt ? Math.max(0, Math.ceil((state.continueDeadlineAt - now) / 1000)) : null;

  useEffect(() => {
    if (!state.continueDeadlineAt) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state.continueDeadlineAt]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-stone-300 bg-white p-3">
      <div className="text-sm text-stone-600">
        <div>
          Continue votes: <strong className="text-stone-900">{readyCount}</strong> / {humanSeats.length}
        </div>
        {waitingNames.length > 0 && <div className="mt-1">Waiting: {waitingNames.join(", ")}</div>}
        {secondsLeft !== null && <div className="mt-1 text-xs font-semibold text-stone-700">Auto continues in {secondsLeft}s</div>}
        {alreadyReady && <div className="mt-1 text-xs text-stone-500">You can click again if the room looks stuck.</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={alreadyReady ? "secondary-btn" : "primary-btn"} onClick={() => socket.emit("continueGame", { code: state.code })}>
          <Play size={18} /> {alreadyReady ? "Send again" : label}
        </button>
        {state.isOwner && (
          <button className="secondary-btn" onClick={() => socket.emit("forceContinue", { code: state.code })}>
            Force continue
          </button>
        )}
      </div>
    </div>
  );
}

function TrickHistory({ state }) {
  if (!state.trickHistory?.length) return null;
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Trick history</h2>
      <div className="space-y-3">
        {state.trickHistory.map((trick) => (
          <div key={`${trick.round}-${trick.trickNumber}`} className="rounded border border-stone-200 p-2">
            <div className="mb-2 text-sm font-semibold">
              Trick {trick.trickNumber}: {state.players[trick.winnerSeat]?.name || `Seat ${trick.winnerSeat + 1}`} won
            </div>
            <div className="flex flex-wrap gap-1 text-xs text-stone-700">
              {trick.played.map((entry) => (
                <span key={`${trick.trickNumber}-${entry.seat}`} className="rounded bg-stone-100 px-2 py-1">
                  {state.players[entry.seat]?.name || `S${entry.seat + 1}`}: {entry.card.label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ card }) {
  const isReverse = card.type === "number" && [11, 22, 33].includes(card.value);
  const style = getCardStyle(card, isReverse);
  return (
    <div className={`relative flex h-24 min-w-16 flex-col items-center justify-center overflow-hidden rounded border px-3 shadow-sm ${style.classes}`}>
      <div className={`absolute left-2 top-2 text-[10px] font-bold uppercase tracking-wide ${style.badgeClass}`}>{style.badge}</div>
      <div className={`text-2xl font-black ${style.valueClass}`}>{card.label}</div>
      {style.icon}
    </div>
  );
}

function getCardStyle(card, isReverse) {
  if (card.type === "death") {
    return {
      badge: "Death",
      badgeClass: "text-red-200",
      valueClass: "tracking-tight",
      classes: "border-red-900 bg-stone-950 text-white",
      icon: <Skull className="mt-1 text-red-300" size={18} />
    };
  }

  if (card.type === "zero") {
    return {
      badge: "Zero",
      badgeClass: "text-amber-700",
      valueClass: "text-amber-950",
      classes: "border-amber-500 bg-amber-100 text-amber-950",
      icon: <div className="mt-1 h-2 w-8 rounded-full bg-amber-500" />
    };
  }

  if (isReverse) {
    return {
      badge: "Reverse",
      badgeClass: "text-sky-700",
      valueClass: "text-sky-950",
      classes: "border-sky-500 bg-sky-50 text-sky-950",
      icon: <RotateCcw className="mt-1 text-sky-700" size={17} />
    };
  }

  return {
    badge: "Card",
    badgeClass: "text-stone-400",
    valueClass: "text-stone-950",
    classes: "border-stone-300 bg-white text-stone-950",
    icon: null
  };
}

function Scoreboard({ state }) {
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Scoreboard</h2>
      <div className="space-y-2">
        {state.players.filter((player) => !player.empty).map((player) => (
          <div key={player.seat} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-stone-200 px-3 py-2">
            <div className="truncate">
              <span className="font-medium">{player.name}</span>
              {player.seat === state.mySeat && <span className="ml-2 text-xs text-stone-500">you</span>}
            </div>
            <strong>{state.scores[player.seat] || 0}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PredictionList({ state }) {
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Predictions</h2>
      <div className="space-y-2">
        {state.players.filter((player) => !player.empty).map((player) => {
          const prediction = state.predictions[player.seat];
          return (
            <div key={player.seat} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{player.name}</span>
              <span className="font-semibold">
                {!prediction ? "..." : prediction.hidden ? <EyeOff size={16} /> : prediction.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoundSummary({ state }) {
  const summary = state.roundSummary;
  if (!summary) return null;
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Round {summary.round} result</h2>
      <div className="grid gap-2 md:grid-cols-5">
        {state.players.filter((player) => !player.empty).map((player) => (
          <div key={player.seat} className="rounded border border-stone-200 p-3">
            <div className="truncate font-medium">{player.name}</div>
            <div className="text-sm text-stone-600">Predicted {summary.predictions[player.seat]?.value}</div>
            <div className="text-sm text-stone-600">Won {summary.actualWins[player.seat]}</div>
            <div className={`mt-1 font-bold ${summary.scoreChanges[player.seat] >= 0 ? "text-green-700" : "text-red-700"}`}>
              {summary.scoreChanges[player.seat] >= 0 ? "+" : ""}
              {summary.scoreChanges[player.seat]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeatGrid({ players, scores, mySeat, isOwner, onRemoveBot }) {
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      {players.map((player, seat) => (
        <div key={seat} className={`rounded border bg-white p-4 ${seat === mySeat ? "border-stone-900" : "border-stone-300"}`}>
          <div className="mb-1 text-xs uppercase text-stone-500">Seat {seat + 1}</div>
          {player.empty ? (
            <div className="text-stone-400">Empty</div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {player.isBot && <Bot size={15} className="shrink-0 text-sky-700" />}
                <div className="truncate font-semibold">{player.name}</div>
              </div>
              <div className="mt-1 text-sm text-stone-600">{player.connected ? "Online" : "Disconnected"}</div>
              <div className="mt-1 text-sm text-stone-600">{player.ready ? "Ready" : "Not ready"}</div>
              <div className="mt-1 text-sm font-semibold">{scores?.[seat] || 0} pts</div>
              {isOwner && player.isBot && (
                <button className="mt-3 inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-100" onClick={() => onRemoveBot(seat)}>
                  <UserMinus size={13} /> Remove
                </button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function FinalResults({ state, socket }) {
  const winner = state.finalResults?.[0];
  return (
    <section className="mx-auto w-full max-w-xl rounded border border-stone-300 bg-white p-5">
      <h2 className="mb-4 flex items-center gap-2 text-2xl font-bold">
        <Crown size={24} /> Final results
      </h2>
      <div className="space-y-2">
        {state.finalResults.map((result, index) => (
          <div key={result.seat} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded border border-stone-200 px-3 py-2">
            <span className="font-semibold">#{index + 1}</span>
            <span className="truncate">{result.name}</span>
            <strong>{result.score}</strong>
          </div>
        ))}
      </div>
      {winner && <p className="mt-4 text-sm text-stone-600">{winner.name} wins.</p>}
      {state.isOwner ? (
        <button className="primary-btn mt-4 w-full" onClick={() => socket.emit("playAgain", { code: state.code })}>
          <Play size={18} /> Play again
        </button>
      ) : (
        <p className="mt-4 rounded border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">Waiting for the room owner to start another game.</p>
      )}
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

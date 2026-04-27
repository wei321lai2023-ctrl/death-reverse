import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { io } from "socket.io-client";
import { Copy, Crown, EyeOff, Play, RotateCcw, Users } from "lucide-react";
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
      {["prediction", "trick", "roundEnd"].includes(state.phase) && <Game state={state} socket={socket} onLeave={leaveRoom} />}
      {state.phase === "gameOver" && <FinalResults state={state} />}
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
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div>
        <RoomCode code={state.code} onLeave={onLeave} />
        <SeatGrid players={state.players} scores={state.scores} mySeat={state.mySeat} />
      </div>
      <aside className="rounded border border-stone-300 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">Lobby</h2>
        <p className="mb-4 text-sm text-stone-600">Game starts automatically when all 5 seats are filled and ready.</p>
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
        {state.phase === "prediction" ? <PredictionPanel state={state} socket={socket} /> : <Table state={state} socket={socket} />}
        {state.phase === "roundEnd" && <RoundSummary state={state} />}
        <Hand state={state} socket={socket} />
      </div>
      <aside className="space-y-4">
        <Scoreboard state={state} />
        <PredictionList state={state} />
      </aside>
    </section>
  );
}

function StatusBar({ state }) {
  const current = state.players[state.currentTurnSeat]?.name || "-";
  const leader = state.players[state.leaderSeat]?.name || "-";
  return (
    <div className="grid gap-2 rounded border border-stone-300 bg-white p-3 sm:grid-cols-4">
      <Metric label="Round" value={`${state.round} / 9`} />
      <Metric label="Trick" value={`${state.trickNumber || 1} / ${state.round || 1}`} />
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
  const order = state.leaderSeat === null ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4].sort((a, b) => relativeSeat(a, state.leaderSeat) - relativeSeat(b, state.leaderSeat));
  return (
    <div className="rounded border border-stone-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Table</h2>
      <div className="grid min-h-48 gap-3 sm:grid-cols-5">
        {order.map((seat) => {
          const play = state.played.find((entry) => entry.seat === seat);
          return (
            <div key={seat} className={`rounded border p-3 ${state.currentTurnSeat === seat ? "border-stone-900 bg-amber-50" : "border-stone-200"}`}>
              <div className="mb-2 truncate text-sm font-medium">{state.players[seat]?.name || `Seat ${seat + 1}`}</div>
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
  if (state.phase === "prediction" || state.phase === "roundEnd") return null;
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
      {!canPlay && <p className="mt-2 text-sm text-stone-500">Waiting for your turn.</p>}
    </div>
  );
}

function Card({ card }) {
  const isReverse = card.type === "number" && [11, 22, 33].includes(card.value);
  const classes = card.type === "death" ? "border-stone-950 bg-stone-950 text-white" : isReverse ? "border-sky-500 bg-sky-50 text-sky-950" : card.type === "zero" ? "border-amber-500 bg-amber-50 text-amber-950" : "border-stone-300 bg-white";
  return (
    <div className={`flex h-24 min-w-16 flex-col items-center justify-center rounded border px-3 ${classes}`}>
      <div className="text-xl font-bold">{card.label}</div>
      {isReverse && <RotateCcw size={16} />}
    </div>
  );
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

function SeatGrid({ players, scores, mySeat }) {
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      {players.map((player, seat) => (
        <div key={seat} className={`rounded border bg-white p-4 ${seat === mySeat ? "border-stone-900" : "border-stone-300"}`}>
          <div className="mb-1 text-xs uppercase text-stone-500">Seat {seat + 1}</div>
          {player.empty ? (
            <div className="text-stone-400">Empty</div>
          ) : (
            <>
              <div className="truncate font-semibold">{player.name}</div>
              <div className="mt-1 text-sm text-stone-600">{player.connected ? "Online" : "Disconnected"}</div>
              <div className="mt-1 text-sm text-stone-600">{player.ready ? "Ready" : "Not ready"}</div>
              <div className="mt-1 text-sm font-semibold">{scores?.[seat] || 0} pts</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function FinalResults({ state }) {
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
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;
const PLAYER_COUNT = 5;
const FINAL_ROUND = 9;
const REVERSE_VALUES = new Set([11, 22, 33]);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get("/", (_req, res) => res.json({ ok: true, name: "Death Reverse server" }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms.has(code) ? makeCode() : code;
}

function makeDeck() {
  const cards = [];
  for (let value = 1; value <= 39; value += 1) {
    cards.push({ id: `n-${value}`, type: "number", value, label: String(value) });
  }
  for (let i = 1; i <= 5; i += 1) {
    cards.push({ id: `z-${i}`, type: "zero", value: 0, label: "0" });
  }
  cards.push({ id: "death", type: "death", value: null, label: "Death" });
  return cards;
}

function shuffle(cards) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function nextSeat(seat) {
  return (seat + 1) % PLAYER_COUNT;
}

function seatOrderFrom(seat) {
  return Array.from({ length: PLAYER_COUNT }, (_, i) => (seat + i) % PLAYER_COUNT);
}

function makeRoom(owner) {
  const code = makeCode();
  const room = {
    code,
    ownerPlayerId: owner.playerId,
    phase: "lobby",
    round: 0,
    trickNumber: 0,
    leaderSeat: null,
    currentTurnSeat: null,
    players: Array(PLAYER_COUNT).fill(null),
    hands: {},
    predictions: {},
    actualWins: {},
    scores: {},
    played: [],
    roundSummary: null,
    finalResults: null,
    nextRoundTimer: null
  };
  room.players[0] = { ...owner, seat: 0, ready: false, connected: true };
  rooms.set(code, room);
  return room;
}

function publicPlayers(room) {
  return room.players.map((player, seat) => {
    if (!player) return { seat, empty: true };
    return {
      seat,
      playerId: player.playerId,
      name: player.name,
      ready: player.ready,
      connected: player.connected,
      hiddenUsed: Boolean(player.hiddenUsed)
    };
  });
}

function visiblePredictions(room, viewerSeat) {
  const result = {};
  for (const [seat, prediction] of Object.entries(room.predictions)) {
    const numericSeat = Number(seat);
    const canReveal = room.phase === "roundEnd" || room.phase === "gameOver" || numericSeat === viewerSeat || !prediction.hidden;
    result[seat] = {
      submitted: true,
      hidden: prediction.hidden && !canReveal,
      value: canReveal ? prediction.value : null
    };
  }
  return result;
}

function stateFor(room, socketId) {
  const viewer = room.players.find((player) => player?.socketId === socketId);
  const viewerSeat = viewer?.seat ?? null;
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    trickNumber: room.trickNumber,
    leaderSeat: room.leaderSeat,
    currentTurnSeat: room.currentTurnSeat,
    players: publicPlayers(room),
    mySeat: viewerSeat,
    hand: viewerSeat === null ? [] : room.hands[viewerSeat] || [],
    handCounts: Object.fromEntries(room.players.map((player, seat) => [seat, player ? room.hands[seat]?.length || 0 : 0])),
    predictions: visiblePredictions(room, viewerSeat),
    actualWins: room.actualWins,
    scores: room.scores,
    played: room.played,
    roundSummary: room.roundSummary,
    finalResults: room.finalResults
  };
}

function emitRoom(room) {
  for (const player of room.players) {
    if (player?.socketId) {
      io.to(player.socketId).emit("roomState", stateFor(room, player.socketId));
    }
  }
}

function emitError(socket, message) {
  socket.emit("gameError", message);
}

function addOrReconnectPlayer(socket, room, payload) {
  const name = String(payload.name || "").trim().slice(0, 24) || "Player";
  const playerId = String(payload.playerId || "").trim();
  if (!playerId) return { error: "Missing player id." };

  const existing = room.players.find((player) => player?.playerId === playerId);
  if (existing) {
    existing.socketId = socket.id;
    existing.name = name;
    existing.connected = true;
    socket.join(room.code);
    return { player: existing };
  }

  if (room.phase !== "lobby") return { error: "Game already started." };
  const seat = room.players.findIndex((player) => !player);
  if (seat === -1) return { error: "Room is full." };

  const player = { playerId, socketId: socket.id, name, seat, ready: false, connected: true, hiddenUsed: false };
  room.players[seat] = player;
  socket.join(room.code);
  return { player };
}

function maybeStartGame(room) {
  if (room.phase !== "lobby") return;
  const full = room.players.every(Boolean);
  const ready = room.players.every((player) => player?.ready);
  if (full && ready) startRound(room, 1);
}

function startRound(room, round) {
  clearTimeout(room.nextRoundTimer);
  const deck = shuffle(makeDeck());
  room.phase = "prediction";
  room.round = round;
  room.trickNumber = 1;
  room.predictions = {};
  room.actualWins = Object.fromEntries(room.players.map((_player, seat) => [seat, 0]));
  room.hands = {};
  room.played = [];
  room.roundSummary = null;
  room.leaderSeat = Math.floor(Math.random() * PLAYER_COUNT);
  room.currentTurnSeat = null;

  for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
    room.hands[seat] = deck.slice(seat * round, seat * round + round).sort(sortCards);
  }
  emitRoom(room);
}

function sortCards(a, b) {
  if (a.type === "death") return 1;
  if (b.type === "death") return -1;
  return a.value - b.value;
}

function maybeStartTricks(room) {
  if (room.phase !== "prediction") return;
  if (Object.keys(room.predictions).length !== PLAYER_COUNT) return;
  room.phase = "trick";
  room.currentTurnSeat = room.leaderSeat;
  room.played = [];
  emitRoom(room);
}

function determineTrickWinner(played) {
  const reverseCount = played.filter(({ card }) => card.type === "number" && REVERSE_VALUES.has(card.value)).length;
  const lowMode = reverseCount % 2 === 1;
  const zeros = played.filter(({ card }) => card.type === "zero");
  const death = played.find(({ card }) => card.type === "death");

  if (death) {
    if (zeros.length > 0) return zeros[0].seat;
    return death.seat;
  }

  const best = played.reduce((winner, entry) => {
    if (!winner) return entry;
    if (lowMode) {
      if (entry.card.value < winner.card.value) return entry;
      return winner;
    }
    if (entry.card.value > winner.card.value) return entry;
    return winner;
  }, null);

  return best.seat;
}

function finishTrick(room) {
  const winnerSeat = determineTrickWinner(room.played);
  room.actualWins[winnerSeat] += 1;
  room.leaderSeat = winnerSeat;

  if (room.trickNumber >= room.round) {
    finishRound(room);
    return;
  }

  room.trickNumber += 1;
  room.played = [];
  room.currentTurnSeat = winnerSeat;
  emitRoom(room);
}

function finishRound(room) {
  const scoreChanges = {};
  const revealedPredictions = {};

  for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
    const predicted = room.predictions[seat].value;
    const actual = room.actualWins[seat];
    let delta;
    if (predicted === 0 && actual === 0) delta = room.round;
    else if (predicted >= 1 && predicted === actual) delta = 2 * predicted;
    else delta = -2 * Math.abs(predicted - actual);

    scoreChanges[seat] = delta;
    room.scores[seat] = (room.scores[seat] || 0) + delta;
    revealedPredictions[seat] = room.predictions[seat];
  }

  room.roundSummary = {
    round: room.round,
    scoreChanges,
    actualWins: { ...room.actualWins },
    predictions: revealedPredictions
  };

  if (room.round >= FINAL_ROUND) {
    room.phase = "gameOver";
    room.finalResults = room.players
      .map((player, seat) => ({ seat, name: player.name, score: room.scores[seat] || 0 }))
      .sort((a, b) => b.score - a.score);
    emitRoom(room);
    return;
  }

  room.phase = "roundEnd";
  room.currentTurnSeat = null;
  room.played = [];
  emitRoom(room);
  room.nextRoundTimer = setTimeout(() => startRound(room, room.round + 1), 6500);
}

io.on("connection", (socket) => {
  socket.on("createRoom", (payload = {}) => {
    const playerId = String(payload.playerId || "").trim();
    if (!playerId) return emitError(socket, "Missing player id.");
    const room = makeRoom({
      playerId,
      socketId: socket.id,
      name: String(payload.name || "").trim().slice(0, 24) || "Player",
      hiddenUsed: false
    });
    socket.join(room.code);
    socket.emit("roomCreated", { code: room.code });
    emitRoom(room);
  });

  socket.on("joinRoom", (payload = {}) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return emitError(socket, "Room not found.");
    const result = addOrReconnectPlayer(socket, room, payload);
    if (result.error) return emitError(socket, result.error);
    emitRoom(room);
  });

  socket.on("setReady", ({ code, ready } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "lobby") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player) return;
    player.ready = Boolean(ready);
    maybeStartGame(room);
    emitRoom(room);
  });

  socket.on("leaveRoom", ({ code } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return;
    const playerIndex = room.players.findIndex((entry) => entry?.socketId === socket.id);
    if (playerIndex === -1) return;
    const leavingPlayer = room.players[playerIndex];

    socket.leave(room.code);
    if (room.phase === "lobby") {
      room.players[playerIndex] = null;
      if (room.players.every((player) => !player)) {
        rooms.delete(room.code);
        return;
      }
      if (room.ownerPlayerId === leavingPlayer.playerId) {
        const nextOwner = room.players.find(Boolean);
        room.ownerPlayerId = nextOwner?.playerId ?? null;
      }
    } else {
      room.players[playerIndex].connected = false;
      room.players[playerIndex].socketId = null;
    }

    socket.emit("leftRoom");
    emitRoom(room);
  });

  socket.on("submitPrediction", ({ code, value, hidden } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "prediction") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player) return;
    const prediction = Number(value);
    if (!Number.isInteger(prediction) || prediction < 0 || prediction > room.round) {
      return emitError(socket, `Prediction must be between 0 and ${room.round}.`);
    }
    const wantsHidden = Boolean(hidden);
    if (wantsHidden && player.hiddenUsed) return emitError(socket, "You already used your hidden prediction.");
    if (wantsHidden) player.hiddenUsed = true;
    room.predictions[player.seat] = { value: prediction, hidden: wantsHidden };
    maybeStartTricks(room);
    emitRoom(room);
  });

  socket.on("playCard", ({ code, cardId } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "trick") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player || player.seat !== room.currentTurnSeat) return;
    if (room.played.some((entry) => entry.seat === player.seat)) return;

    const hand = room.hands[player.seat] || [];
    const cardIndex = hand.findIndex((card) => card.id === cardId);
    if (cardIndex === -1) return emitError(socket, "Card not in hand.");

    const [card] = hand.splice(cardIndex, 1);
    room.played.push({ seat: player.seat, card, order: room.played.length });

    if (room.played.length === PLAYER_COUNT) {
      room.currentTurnSeat = null;
      emitRoom(room);
      setTimeout(() => finishTrick(room), 1200);
      return;
    }

    let next = nextSeat(player.seat);
    while (room.played.some((entry) => entry.seat === next)) next = nextSeat(next);
    room.currentTurnSeat = next;
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find((entry) => entry?.socketId === socket.id);
      if (!player) continue;
      player.connected = false;
      player.socketId = null;
      emitRoom(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Death Reverse server listening on ${PORT}`);
});

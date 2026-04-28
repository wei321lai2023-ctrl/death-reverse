import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import botParams from "./bot-params.json" with { type: "json" };

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || true;
const PLAYER_COUNT = 5;
const FINAL_ROUND = 9;
const CONTINUE_TIMEOUT_MS = 30000;
const REVERSE_VALUES = new Set([11, 22, 33]);
const BOT_NAMES = ["Bot Ada", "Bot Ben", "Bot Cora", "Bot Dex", "Bot Eve"];

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
    lastTrick: null,
    trickHistory: [],
    continueVotes: {},
    roundSummary: null,
    finalResults: null,
    botTimer: null,
    continueTimer: null,
    continueDeadlineAt: null,
    botCounter: 0
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
      hiddenUsed: Boolean(player.hiddenUsed),
      isBot: Boolean(player.isBot)
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
    isOwner: viewer?.playerId === room.ownerPlayerId,
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
    lastTrick: room.lastTrick,
    trickHistory: room.trickHistory,
    continueVotes: room.continueVotes,
    continueDeadlineAt: room.continueDeadlineAt,
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

function emitAndSchedule(room) {
  emitRoom(room);
  scheduleBotWork(room);
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
  const botSeat = room.players.findIndex((player) => player?.isBot);
  const targetSeat = seat === -1 ? botSeat : seat;
  if (targetSeat === -1) return { error: "Room is full." };

  const player = { playerId, socketId: socket.id, name, seat: targetSeat, ready: false, connected: true, hiddenUsed: false, isBot: false };
  room.players[targetSeat] = player;
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
  clearContinueTimer(room);
  const deck = shuffle(makeDeck());
  room.phase = "prediction";
  room.round = round;
  room.trickNumber = 1;
  room.predictions = {};
  room.actualWins = Object.fromEntries(room.players.map((_player, seat) => [seat, 0]));
  room.hands = {};
  room.played = [];
  room.lastTrick = null;
  room.trickHistory = [];
  room.continueVotes = {};
  room.roundSummary = null;
  room.leaderSeat = Math.floor(Math.random() * PLAYER_COUNT);
  room.currentTurnSeat = null;

  for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
    room.hands[seat] = deck.slice(seat * round, seat * round + round).sort(sortCards);
  }
  emitAndSchedule(room);
}

function sortCards(a, b) {
  if (a.type === "death") return 1;
  if (b.type === "death") return -1;
  return a.value - b.value;
}

function maybeStartTricks(room) {
  if (room.phase !== "prediction") return;
  if (Object.keys(room.predictions).length !== PLAYER_COUNT) return;
  clearContinueTimer(room);
  room.phase = "trick";
  room.currentTurnSeat = room.leaderSeat;
  room.played = [];
  emitAndSchedule(room);
}

function clearContinueTimer(room) {
  clearTimeout(room.continueTimer);
  room.continueTimer = null;
  room.continueDeadlineAt = null;
}

function scheduleContinueTimer(room) {
  clearContinueTimer(room);
  const deadline = Date.now() + CONTINUE_TIMEOUT_MS;
  room.continueDeadlineAt = deadline;
  room.continueTimer = setTimeout(() => {
    if (!["trickResult", "roundEnd"].includes(room.phase)) return;
    if (room.continueDeadlineAt !== deadline) return;
    forceContinue(room);
  }, CONTINUE_TIMEOUT_MS);
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
  room.lastTrick = {
    round: room.round,
    trickNumber: room.trickNumber,
    winnerSeat,
    played: room.played.map((entry) => ({ ...entry }))
  };
  room.trickHistory.push(room.lastTrick);
  room.phase = "trickResult";
  room.currentTurnSeat = null;
  room.continueVotes = Object.fromEntries(room.players.map((player, seat) => [seat, Boolean(player?.isBot)]));
  scheduleContinueTimer(room);
  emitRoom(room);
}

function continueAfterTrick(room) {
  if (room.phase !== "trickResult") return;
  clearContinueTimer(room);
  if (room.trickNumber >= room.round) {
    finishRound(room);
    return;
  }

  room.trickNumber += 1;
  room.played = [];
  room.currentTurnSeat = room.leaderSeat;
  room.phase = "trick";
  room.continueVotes = {};
  emitAndSchedule(room);
}

function eligibleContinueSeats(room) {
  return room.players.filter((player) => player && !player.isBot && player.connected).map((player) => player.seat);
}

function allHumansContinued(room) {
  const seats = eligibleContinueSeats(room);
  return seats.length === 0 || seats.every((seat) => room.continueVotes[seat]);
}

function markContinue(room, seat) {
  if (!["trickResult", "roundEnd"].includes(room.phase)) return;
  room.continueVotes[seat] = true;
  if (!allHumansContinued(room)) {
    emitRoom(room);
    return;
  }

  if (room.phase === "trickResult") {
    continueAfterTrick(room);
    return;
  }

  if (room.phase === "roundEnd") {
    startRound(room, room.round + 1);
  }
}

function forceContinue(room) {
  if (room.phase === "trickResult") {
    continueAfterTrick(room);
    return;
  }
  if (room.phase === "roundEnd") {
    startRound(room, room.round + 1);
  }
}

function resetRoomForRematch(room) {
  clearTimeout(room.botTimer);
  clearContinueTimer(room);
  room.phase = "lobby";
  room.round = 0;
  room.trickNumber = 0;
  room.leaderSeat = null;
  room.currentTurnSeat = null;
  room.hands = {};
  room.predictions = {};
  room.actualWins = {};
  room.scores = {};
  room.played = [];
  room.lastTrick = null;
  room.trickHistory = [];
  room.continueVotes = {};
  room.roundSummary = null;
  room.finalResults = null;

  for (const player of room.players) {
    if (!player) continue;
    player.ready = Boolean(player.isBot);
    player.hiddenUsed = false;
  }
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
    clearContinueTimer(room);
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
  room.continueVotes = Object.fromEntries(room.players.map((player, seat) => [seat, Boolean(player?.isBot)]));
  scheduleContinueTimer(room);
  emitRoom(room);
}

function addBot(room) {
  if (room.phase !== "lobby") return { error: "Bots can only be added in the lobby." };
  const seat = room.players.findIndex((player) => !player);
  if (seat === -1) return { error: "Room is full." };
  room.botCounter += 1;
  const name = BOT_NAMES[(room.botCounter - 1) % BOT_NAMES.length];
  room.players[seat] = {
    playerId: `bot-${room.code}-${room.botCounter}`,
    socketId: null,
    name,
    seat,
    ready: true,
    connected: true,
    hiddenUsed: false,
    isBot: true
  };
  return { bot: room.players[seat] };
}

function removeBot(room, seat) {
  if (room.phase !== "lobby") return { error: "Bots can only be removed in the lobby." };
  const player = room.players[seat];
  if (!player?.isBot) return { error: "No bot in that seat." };
  room.players[seat] = null;
  return { ok: true };
}

function scheduleBotWork(room, delay = 550) {
  clearTimeout(room.botTimer);
  if (!["prediction", "trick"].includes(room.phase)) return;
  room.botTimer = setTimeout(() => runBotWork(room), delay);
}

function runBotWork(room) {
  if (room.phase === "prediction") {
    let changed = false;
    for (const player of room.players) {
      if (!player?.isBot || room.predictions[player.seat]) continue;
      room.predictions[player.seat] = { value: predictForBot(room, player.seat), hidden: false };
      changed = true;
    }
    if (changed) maybeStartTricks(room);
    else scheduleBotWork(room, 800);
    if (changed && room.phase === "prediction") emitAndSchedule(room);
    return;
  }

  if (room.phase !== "trick") return;
  const player = room.players[room.currentTurnSeat];
  if (!player?.isBot) return;
  playBotCard(room, player.seat);
}

function predictForBot(room, seat) {
  const hand = room.hands[seat] || [];
  let strength = 0;
  for (const card of hand) {
    if (card.type === "death") strength += botParams.deathPredict;
    else if (card.type === "zero") strength += room.round >= 4 ? botParams.zeroPredictLate : botParams.zeroPredictEarly;
    else if (REVERSE_VALUES.has(card.value)) strength += botParams.reversePredict;
    else if (card.value >= 35) strength += botParams.high35Predict;
    else if (card.value >= 29) strength += botParams.high29Predict;
    else if (card.value >= 22) strength += botParams.high22Predict;
    else if (card.value <= 4) strength += botParams.lowCardPredict;
  }
  const conservative = room.round <= 3 ? botParams.earlyConservative : botParams.lateConservative;
  return Math.max(0, Math.min(room.round, Math.round(strength * conservative)));
}

function playBotCard(room, seat) {
  const hand = room.hands[seat] || [];
  if (!hand.length || room.currentTurnSeat !== seat) return;

  const prediction = room.predictions[seat]?.value ?? 0;
  const won = room.actualWins[seat] || 0;
  const remainingAfterThis = Math.max(0, room.round - room.trickNumber);
  const needWins = prediction - won;
  const shouldTryWin = needWins > 0 && (needWins >= remainingAfterThis || Math.random() < botParams.tryWinChance);
  const card = chooseBotCard(room, seat, shouldTryWin);
  const cardIndex = hand.findIndex((entry) => entry.id === card.id);
  const [playedCard] = hand.splice(cardIndex, 1);
  room.played.push({ seat, card: playedCard, order: room.played.length });

  if (room.played.length === PLAYER_COUNT) {
    room.currentTurnSeat = null;
    finishTrick(room);
    return;
  }

  let next = nextSeat(seat);
  while (room.played.some((entry) => entry.seat === next)) next = nextSeat(next);
  room.currentTurnSeat = next;
  emitAndSchedule(room);
}

function chooseBotCard(room, seat, shouldTryWin) {
  const hand = room.hands[seat] || [];
  const scored = hand.map((card) => {
    const projected = [...room.played, { seat, card, order: room.played.length }];
    const winnerIfPlayed = determineTrickWinner(projected);
    const currentlyWinning = winnerIfPlayed === seat;
    const power = cardPower(card);
    const reverseRisk = card.type === "number" && REVERSE_VALUES.has(card.value) ? botParams.reverseRisk : 0;
    const deathBonus = card.type === "death" ? botParams.deathAvoidPenalty : 0;
    const zeroVsDeathBonus = card.type === "zero" && room.played.some((entry) => entry.card.type === "death") ? botParams.zeroVsDeathBonus : 0;
    const opponentImpact = scoreOpponentImpact(room, seat, winnerIfPlayed);

    if (shouldTryWin) {
      return { card, score: (currentlyWinning ? botParams.winBonus + power + zeroVsDeathBonus - reverseRisk : -botParams.missGoalPenalty - power) + opponentImpact };
    }
    return { card, score: (currentlyWinning ? botParams.losePenalty - botParams.forcedWinPenalty : 0) - power + power * botParams.burnPowerWhenSafe - deathBonus + reverseRisk + opponentImpact };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].card;
}

function scoreOpponentImpact(room, seat, winnerSeat) {
  if (winnerSeat === seat || !room.players[winnerSeat]) return 0;
  const prediction = room.predictions[winnerSeat]?.value;
  if (prediction === undefined) return 0;

  const selfScore = room.scores[seat] || 0;
  const winnerScore = room.scores[winnerSeat] || 0;
  const beforeWins = room.actualWins[winnerSeat] || 0;
  const afterWins = beforeWins + 1;
  const beforeDistance = Math.abs(prediction - beforeWins);
  const afterDistance = Math.abs(prediction - afterWins);
  const scoreLead = Math.max(0, winnerScore - selfScore);
  const leadWeight = 1 + scoreLead / 20;
  let impact = 0;

  if (afterDistance > beforeDistance) {
    impact += botParams.opponentFailPressure * leadWeight;
  } else if (afterDistance < beforeDistance) {
    impact -= botParams.opponentFailPressure * leadWeight;
  }

  if (scoreLead > 0 && afterDistance > beforeDistance) {
    impact += botParams.leaderSabotage * leadWeight;
  }

  if (prediction === 0 && beforeWins === 0) {
    const lateRoundWeight = 1 + room.round / FINAL_ROUND;
    const zeroSuccessScore = winnerScore + room.round;
    impact += botParams.zeroPredictionPressure * lateRoundWeight * leadWeight;
    if (zeroSuccessScore >= selfScore) {
      impact += botParams.zeroClimberPressure * (1 + Math.max(0, zeroSuccessScore - selfScore) / 20);
    }
  }

  if (selfScore < winnerScore) {
    impact += botParams.protectTrailingSelf * (afterDistance > beforeDistance ? 1 : -0.5);
  }

  return impact;
}

function cardPower(card) {
  if (card.type === "death") return botParams.deathPower;
  if (card.type === "zero") return botParams.zeroPower;
  if (REVERSE_VALUES.has(card.value)) return botParams.reversePower;
  return card.value / botParams.normalPowerScale;
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

  socket.on("addBot", ({ code } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "lobby") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player || player.playerId !== room.ownerPlayerId) return emitError(socket, "Only the room owner can add bots.");
    const result = addBot(room);
    if (result.error) return emitError(socket, result.error);
    maybeStartGame(room);
    emitRoom(room);
  });

  socket.on("removeBot", ({ code, seat } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "lobby") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player || player.playerId !== room.ownerPlayerId) return emitError(socket, "Only the room owner can remove bots.");
    const result = removeBot(room, Number(seat));
    if (result.error) return emitError(socket, result.error);
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
      const humanPlayers = room.players.filter((player) => player && !player.isBot);
      if (humanPlayers.length === 0) {
        clearTimeout(room.botTimer);
        clearContinueTimer(room);
        rooms.delete(room.code);
        return;
      }
      if (room.ownerPlayerId === leavingPlayer.playerId) {
        const nextOwner = humanPlayers[0];
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
      finishTrick(room);
      return;
    }

    let next = nextSeat(player.seat);
    while (room.played.some((entry) => entry.seat === next)) next = nextSeat(next);
    room.currentTurnSeat = next;
    emitAndSchedule(room);
  });

  socket.on("continueGame", ({ code } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !["trickResult", "roundEnd"].includes(room.phase)) return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player) return;
    markContinue(room, player.seat);
  });

  socket.on("forceContinue", ({ code } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || !["trickResult", "roundEnd"].includes(room.phase)) return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player || player.playerId !== room.ownerPlayerId) return emitError(socket, "Only the room owner can force continue.");
    forceContinue(room);
  });

  socket.on("playAgain", ({ code } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "gameOver") return;
    const player = room.players.find((entry) => entry?.socketId === socket.id);
    if (!player || player.playerId !== room.ownerPlayerId) return emitError(socket, "Only the room owner can start a new game.");
    resetRoomForRematch(room);
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

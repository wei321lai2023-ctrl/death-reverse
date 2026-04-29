import botParams from "../src/bot-params.json" with { type: "json" };

const PLAYER_COUNT = 5;
const FINAL_ROUND = 9;
const REVERSE_VALUES = new Set([11, 22, 33]);
const GAMES = Number(process.argv.find((arg) => arg.startsWith("--games="))?.split("=")[1] ?? 8000);
const seedArg = Number(process.argv.find((arg) => arg.startsWith("--seed="))?.split("=")[1] ?? 13579);
const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] ?? "lookahead";

function run() {
  const random = makeRng(seedArg);
  const stats = Array.from({ length: FINAL_ROUND + 1 }, () => ({
    total: 0,
    score: 0,
    zeroPred: 0,
    zeroSuccess: 0,
    zeroScore: 0
  }));

  for (let game = 0; game < GAMES; game += 1) {
    const scores = Array(PLAYER_COUNT).fill(0);
    for (let round = 1; round <= FINAL_ROUND; round += 1) {
      const hands = deal(round, random);
      const predictions = hands.map((hand) => predict(hand, round));
      const actualWins = Array(PLAYER_COUNT).fill(0);
      const trickHistory = [];
      let leaderSeat = Math.floor(random() * PLAYER_COUNT);

      for (let trickNumber = 1; trickNumber <= round; trickNumber += 1) {
        const played = [];
        for (const seat of seatOrderFrom(leaderSeat)) {
          const card = chooseCard({ hands, trickHistory, played, seat, round, trickNumber, predictions, actualWins, scores, random });
          hands[seat].splice(hands[seat].findIndex((entry) => entry.id === card.id), 1);
          played.push({ seat, card, order: played.length });
        }
        leaderSeat = determineTrickWinner(played);
        actualWins[leaderSeat] += 1;
        trickHistory.push({ played: played.map((entry) => ({ ...entry })) });
      }

      for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
        const delta = scoreRound(round, predictions[seat], actualWins[seat]);
        scores[seat] += delta;
        stats[round].total += 1;
        stats[round].score += delta;
        if (predictions[seat] === 0) {
          stats[round].zeroPred += 1;
          stats[round].zeroScore += delta;
          if (actualWins[seat] === 0) stats[round].zeroSuccess += 1;
        }
      }
    }
  }

  console.log(`Mode: ${mode}, seed: ${seedArg}, games: ${GAMES}`);
  console.log("round | zeroPred | zeroSuccess% | zeroEV | scoreEV");
  for (let round = 1; round <= FINAL_ROUND; round += 1) {
    const row = stats[round];
    console.log([
      round,
      row.zeroPred,
      `${percent(row.zeroSuccess, row.zeroPred).toFixed(1)}%`,
      avg(row.zeroScore, row.zeroPred).toFixed(2),
      avg(row.score, row.total).toFixed(2)
    ].join(" | "));
  }
}

function predict(hand, round) {
  let strength = 0;
  for (const card of hand) {
    if (card.type === "death") strength += botParams.deathPredict;
    else if (card.type === "zero") strength += round >= 4 ? botParams.zeroPredictLate : botParams.zeroPredictEarly;
    else if (REVERSE_VALUES.has(card.value)) strength += botParams.reversePredict;
    else if (card.value >= 35) strength += botParams.high35Predict;
    else if (card.value >= 29) strength += botParams.high29Predict;
    else if (card.value >= 22) strength += botParams.high22Predict;
    else if (card.value <= 4) strength += botParams.lowCardPredict;
  }
  const conservative = round <= 3 ? botParams.earlyConservative : botParams.lateConservative;
  return clamp(Math.round(strength * conservative), 0, round);
}

function chooseCard({ hands, trickHistory, played, seat, round, trickNumber, predictions, actualWins, scores, random }) {
  const hand = hands[seat];
  const prediction = predictions[seat];
  const won = actualWins[seat] || 0;
  const remainingAfterThis = Math.max(0, round - trickNumber);
  const needWins = prediction - won;
  const shouldTryWin = needWins > 0 && (needWins >= remainingAfterThis || random() < botParams.tryWinChance);
  const scored = hand.map((card) => {
    const projected = [...played, { seat, card, order: played.length }];
    const winnerIfPlayed = determineTrickWinner(projected);
    const currentlyWinning = winnerIfPlayed === seat;
    const power = cardPower(card);
    const reverseRisk = card.type === "number" && REVERSE_VALUES.has(card.value) ? botParams.reverseRisk : 0;
    const deathBonus = card.type === "death" ? botParams.deathAvoidPenalty : 0;
    const zeroVsDeathBonus = card.type === "zero" && played.some((entry) => entry.card.type === "death") ? botParams.zeroVsDeathBonus : 0;
    const opponentImpact = scoreOpponentImpact({ seat, winnerSeat: winnerIfPlayed, round, predictions, actualWins, scores });
    const lookaheadBonus = mode === "baseline" ? 0 : zeroLookaheadBonus({ hands, trickHistory, played, projected, seat, round, predictions, actualWins, scores });
    const base = shouldTryWin
      ? (currentlyWinning ? botParams.winBonus + power + zeroVsDeathBonus - reverseRisk : -botParams.missGoalPenalty - power) + opponentImpact + lookaheadBonus
      : (currentlyWinning ? botParams.losePenalty - botParams.forcedWinPenalty : 0) - power + power * botParams.burnPowerWhenSafe - deathBonus + reverseRisk + opponentImpact + lookaheadBonus;
    return { card, currentlyWinning, lookaheadBonus, score: base + (random() - 0.5) * 0.03 };
  });

  const hasDirectZeroPressure = scored.some((entry) => entry.lookaheadBonus > 0);
  const finalized = scored.map((entry) => {
    const setupBonus = mode === "baseline" || hasDirectZeroPressure ? 0 : zeroSetupPressureBonus({ seat, round, currentlyWinning: entry.currentlyWinning, predictions, actualWins, scores });
    return { ...entry, score: entry.score + setupBonus };
  });
  finalized.sort((a, b) => b.score - a.score);
  return finalized[0].card;
}

function zeroLookaheadBonus({ hands, trickHistory, played, projected, seat, round, predictions, actualWins, scores }) {
  if (round < (botParams.zeroLookaheadMinRound || 6)) return 0;
  let bonus = 0;
  for (const targetSeat of remainingSeatsAfter(projected, seat)) {
    if (predictions[targetSeat] !== 0 || (actualWins[targetSeat] || 0) > 0) continue;
    const forceChance = estimateZeroTargetForceChance({ hands, trickHistory, played, seat, targetSeat, projected });
    if (forceChance <= 0) continue;

    const selfScore = scores[seat] || 0;
    const targetScore = scores[targetSeat] || 0;
    const leaderWeight = 1 + Math.max(0, targetScore - selfScore) / 18;
    const climberWeight = targetScore + round >= selfScore ? 1.4 : 1;
    const lateWeight = 1 + round / FINAL_ROUND;
    bonus += forceChance * lateWeight * leaderWeight * climberWeight * (botParams.zeroLookaheadPressure || 0);
  }
  return bonus;
}

function estimateZeroTargetForceChance({ hands, trickHistory, played, seat, targetSeat, projected }) {
  const targetHandCount = hands[targetSeat]?.length || 0;
  if (!targetHandCount) return 0;

  const knownCards = new Set();
  for (const card of hands[seat] || []) knownCards.add(card.id);
  for (const entry of [...played, ...trickHistory.flatMap((trick) => trick.played || [])]) knownCards.add(entry.card.id);
  for (const entry of projected) knownCards.add(entry.card.id);

  let winningUnknown = 0;
  let unknownCount = 0;
  for (const card of makeDeck()) {
    if (knownCards.has(card.id)) continue;
    unknownCount += 1;
    if (determineTrickWinner([...projected, { seat: targetSeat, card, order: projected.length }]) === targetSeat) winningUnknown += 1;
  }
  if (!unknownCount) return 0;
  const drawChance = Math.min(1, targetHandCount / unknownCount);
  return Math.min(1, (winningUnknown / unknownCount) * targetHandCount * drawChance);
}

function zeroSetupPressureBonus({ seat, round, currentlyWinning, predictions, actualWins, scores }) {
  if (!currentlyWinning || round < (botParams.zeroSetupMinRound || 6)) return 0;
  const selfPrediction = predictions[seat] ?? 0;
  const selfActual = actualWins[seat] || 0;
  const selfMissCost = selfPrediction === selfActual ? Math.max(2, round / 2) : 0;
  const selfScore = scores[seat] || 0;
  let bestSetup = 0;

  for (let targetSeat = 0; targetSeat < PLAYER_COUNT; targetSeat += 1) {
    if (targetSeat === seat || predictions[targetSeat] !== 0 || (actualWins[targetSeat] || 0) > 0) continue;
    const targetScore = scores[targetSeat] || 0;
    const targetThreatScore = targetScore + round;
    if (targetScore <= selfScore && targetThreatScore < selfScore) continue;
    const targetOrderIfLeadNext = relativeSeat(targetSeat, seat);
    if (targetOrderIfLeadNext < 3) continue;
    const orderWeight = targetOrderIfLeadNext / 4;
    const swing = round + 2;
    const scoreThreat = 1 + Math.max(0, targetThreatScore - selfScore) / 18;
    const value = (swing * orderWeight * scoreThreat * (botParams.zeroSetupPressure || 0)) / 6 - selfMissCost * 0.55;
    bestSetup = Math.max(bestSetup, value);
  }
  return Math.max(0, bestSetup);
}

function scoreOpponentImpact({ seat, winnerSeat, round, predictions, actualWins, scores }) {
  if (winnerSeat === seat || predictions[winnerSeat] === undefined) return 0;
  const selfScore = scores[seat] || 0;
  const winnerScore = scores[winnerSeat] || 0;
  const beforeWins = actualWins[winnerSeat] || 0;
  const afterWins = beforeWins + 1;
  const beforeDistance = Math.abs(predictions[winnerSeat] - beforeWins);
  const afterDistance = Math.abs(predictions[winnerSeat] - afterWins);
  const scoreLead = Math.max(0, winnerScore - selfScore);
  const leadWeight = 1 + scoreLead / 20;
  let impact = 0;

  if (afterDistance > beforeDistance) impact += botParams.opponentFailPressure * leadWeight;
  else if (afterDistance < beforeDistance) impact -= botParams.opponentFailPressure * leadWeight;
  if (scoreLead > 0 && afterDistance > beforeDistance) impact += botParams.leaderSabotage * leadWeight;
  if (predictions[winnerSeat] === 0 && beforeWins === 0) {
    const lateRoundWeight = 1 + round / FINAL_ROUND;
    const zeroSuccessScore = winnerScore + round;
    impact += botParams.zeroPredictionPressure * lateRoundWeight * leadWeight;
    if (zeroSuccessScore >= selfScore) impact += botParams.zeroClimberPressure * (1 + Math.max(0, zeroSuccessScore - selfScore) / 20);
  }
  if (selfScore < winnerScore) impact += botParams.protectTrailingSelf * (afterDistance > beforeDistance ? 1 : -0.5);
  return impact;
}

function makeDeck() {
  const cards = [];
  for (let value = 1; value <= 39; value += 1) cards.push({ id: `n-${value}`, type: "number", value, label: String(value) });
  for (let i = 1; i <= 5; i += 1) cards.push({ id: `z-${i}`, type: "zero", value: 0, label: "0" });
  cards.push({ id: "death", type: "death", value: null, label: "Death" });
  return cards;
}

function deal(round, random) {
  const deck = shuffle(makeDeck(), random);
  return Array.from({ length: PLAYER_COUNT }, (_unused, seat) => deck.slice(seat * round, seat * round + round).sort(sortCards));
}

function shuffle(cards, random) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sortCards(a, b) {
  if (a.type === "death") return 1;
  if (b.type === "death") return -1;
  return a.value - b.value;
}

function seatOrderFrom(seat) {
  return Array.from({ length: PLAYER_COUNT }, (_unused, i) => (seat + i) % PLAYER_COUNT);
}

function nextSeat(seat) {
  return (seat + 1) % PLAYER_COUNT;
}

function relativeSeat(seat, leaderSeat) {
  return (seat - leaderSeat + PLAYER_COUNT) % PLAYER_COUNT;
}

function remainingSeatsAfter(played, currentSeat) {
  const playedSeats = new Set(played.map((entry) => entry.seat));
  const seats = [];
  let seat = nextSeat(currentSeat);
  while (!playedSeats.has(seat)) {
    seats.push(seat);
    seat = nextSeat(seat);
  }
  return seats;
}

function determineTrickWinner(played) {
  const reverseCount = played.filter(({ card }) => card.type === "number" && REVERSE_VALUES.has(card.value)).length;
  const lowMode = reverseCount % 2 === 1;
  const zeros = played.filter(({ card }) => card.type === "zero");
  const death = played.find(({ card }) => card.type === "death");
  if (death) return zeros.length > 0 ? zeros[0].seat : death.seat;
  return played.reduce((winner, entry) => {
    if (!winner) return entry;
    if (lowMode) return entry.card.value < winner.card.value ? entry : winner;
    return entry.card.value > winner.card.value ? entry : winner;
  }, null).seat;
}

function scoreRound(round, predicted, actual) {
  if (predicted === 0 && actual === 0) return round;
  if (predicted >= 1 && predicted === actual) return 2 * predicted;
  return -2 * Math.abs(predicted - actual);
}

function cardPower(card) {
  if (card.type === "death") return botParams.deathPower;
  if (card.type === "zero") return botParams.zeroPower;
  if (REVERSE_VALUES.has(card.value)) return botParams.reversePower;
  return card.value / botParams.normalPowerScale;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percent(value, total) {
  return total ? (value / total) * 100 : 0;
}

function avg(value, total) {
  return total ? value / total : 0;
}

function makeRng(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

run();

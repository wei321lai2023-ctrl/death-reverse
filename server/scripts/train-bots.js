import fs from "node:fs";
import path from "node:path";
import baseParams from "../src/bot-params.json" with { type: "json" };

const PLAYER_COUNT = 5;
const FINAL_ROUND = 9;
const REVERSE_VALUES = new Set([11, 22, 33]);
const PARAM_PATH = path.resolve("src/bot-params.json");

const args = parseArgs(process.argv.slice(2));
const iterations = Number(args.iterations ?? args.i ?? 40);
const gamesPerCandidate = Number(args.games ?? args.g ?? 120);
const seed = Number(args.seed ?? Date.now());
const write = Boolean(args.write);
const rng = makeRng(seed);

let bestParams = { ...baseParams };
let bestScore = evaluateCandidate(bestParams, gamesPerCandidate, rng);

console.log(`Seed: ${seed}`);
console.log(`Baseline edge: ${bestScore.toFixed(3)} points/game over baseline seats`);

for (let i = 1; i <= iterations; i += 1) {
  const candidate = mutateParams(bestParams, rng, i);
  const score = evaluateCandidate(candidate, gamesPerCandidate, rng);
  const mark = score > bestScore ? "keep" : "skip";
  console.log(`${String(i).padStart(3, "0")} ${mark} edge=${score.toFixed(3)} best=${bestScore.toFixed(3)}`);
  if (score > bestScore) {
    bestScore = score;
    bestParams = candidate;
  }
}

console.log("\nBest params:");
console.log(JSON.stringify(bestParams, null, 2));
console.log(`Best edge: ${bestScore.toFixed(3)} points/game`);

if (write) {
  fs.writeFileSync(PARAM_PATH, `${JSON.stringify(bestParams, null, 2)}\n`);
  console.log(`Wrote ${PARAM_PATH}`);
} else {
  console.log("Dry run only. Add --write to update server/src/bot-params.json.");
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function evaluateCandidate(candidate, games, random) {
  let candidateScore = 0;
  let baselineScore = 0;
  for (let game = 0; game < games; game += 1) {
    const scores = playGame([candidate, baseParams, baseParams, baseParams, baseParams], random);
    candidateScore += scores[0];
    baselineScore += (scores[1] + scores[2] + scores[3] + scores[4]) / 4;
  }
  return (candidateScore - baselineScore) / games - scenarioPenalty(candidate);
}

function playGame(paramsBySeat, random) {
  const scores = Array(PLAYER_COUNT).fill(0);
  for (let round = 1; round <= FINAL_ROUND; round += 1) {
    const hands = deal(round, random);
    const predictions = hands.map((hand, seat) => predict(hand, round, paramsBySeat[seat]));
    const actualWins = Array(PLAYER_COUNT).fill(0);
    let leaderSeat = Math.floor(random() * PLAYER_COUNT);

    for (let trickNumber = 1; trickNumber <= round; trickNumber += 1) {
      const played = [];
      const order = seatOrderFrom(leaderSeat);
      for (const seat of order) {
        const card = chooseCard({
          hand: hands[seat],
          played,
          seat,
          round,
          trickNumber,
          prediction: predictions[seat],
          actualWins: actualWins[seat],
          predictions,
          actualWinsBySeat: actualWins,
          scores,
          params: paramsBySeat[seat],
          random
        });
        hands[seat].splice(hands[seat].findIndex((entry) => entry.id === card.id), 1);
        played.push({ seat, card, order: played.length });
      }
      leaderSeat = determineTrickWinner(played);
      actualWins[leaderSeat] += 1;
    }

    for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
      scores[seat] += scoreRound(round, predictions[seat], actualWins[seat]);
    }
  }
  return scores;
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

function predict(hand, round, params) {
  let strength = 0;
  for (const card of hand) {
    if (card.type === "death") strength += params.deathPredict;
    else if (card.type === "zero") strength += round >= 4 ? params.zeroPredictLate : params.zeroPredictEarly;
    else if (REVERSE_VALUES.has(card.value)) strength += params.reversePredict;
    else if (card.value >= 35) strength += params.high35Predict;
    else if (card.value >= 29) strength += params.high29Predict;
    else if (card.value >= 22) strength += params.high22Predict;
    else if (card.value <= 4) strength += params.lowCardPredict;
  }
  const conservative = round <= 3 ? params.earlyConservative : params.lateConservative;
  return clamp(Math.round(strength * conservative), 0, round);
}

function chooseCard({ hand, played, seat, round, trickNumber, prediction, actualWins, predictions = [], actualWinsBySeat = [], scores = [], params, random }) {
  const remainingAfterThis = Math.max(0, round - trickNumber);
  const needWins = prediction - actualWins;
  const shouldTryWin = needWins > 0 && (needWins >= remainingAfterThis || random() < params.tryWinChance);
  const scored = hand.map((card) => {
    const projected = [...played, { seat, card, order: played.length }];
    const winnerIfPlayed = determineTrickWinner(projected);
    const currentlyWinning = winnerIfPlayed === seat;
    const power = cardPower(card, params);
    const reverseRisk = card.type === "number" && REVERSE_VALUES.has(card.value) ? params.reverseRisk : 0;
    const deathBonus = card.type === "death" ? params.deathAvoidPenalty : 0;
    const zeroVsDeathBonus = card.type === "zero" && played.some((entry) => entry.card.type === "death") ? params.zeroVsDeathBonus : 0;
    const opponentImpact = scoreOpponentImpact({ seat, winnerSeat: winnerIfPlayed, round, predictions, actualWinsBySeat, scores, params });
    const jitter = (random() - 0.5) * 0.03;

    if (shouldTryWin) {
      return { card, score: (currentlyWinning ? params.winBonus + power + zeroVsDeathBonus - reverseRisk : -params.missGoalPenalty - power) + opponentImpact + jitter };
    }
    return { card, score: (currentlyWinning ? params.losePenalty - params.forcedWinPenalty : 0) - power + power * params.burnPowerWhenSafe - deathBonus + reverseRisk + opponentImpact + jitter };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].card;
}

function scoreOpponentImpact({ seat, winnerSeat, round, predictions, actualWinsBySeat, scores, params }) {
  if (winnerSeat === seat || predictions[winnerSeat] === undefined) return 0;
  const selfScore = scores[seat] || 0;
  const winnerScore = scores[winnerSeat] || 0;
  const beforeWins = actualWinsBySeat[winnerSeat] || 0;
  const afterWins = beforeWins + 1;
  const beforeDistance = Math.abs(predictions[winnerSeat] - beforeWins);
  const afterDistance = Math.abs(predictions[winnerSeat] - afterWins);
  const scoreLead = Math.max(0, winnerScore - selfScore);
  const leadWeight = 1 + scoreLead / 20;
  let impact = 0;

  if (afterDistance > beforeDistance) impact += params.opponentFailPressure * leadWeight;
  else if (afterDistance < beforeDistance) impact -= params.opponentFailPressure * leadWeight;

  if (scoreLead > 0 && afterDistance > beforeDistance) impact += params.leaderSabotage * leadWeight;
  if (predictions[winnerSeat] === 0 && beforeWins === 0) {
    const lateRoundWeight = 1 + round / FINAL_ROUND;
    const zeroSuccessScore = winnerScore + round;
    impact += params.zeroPredictionPressure * lateRoundWeight * leadWeight;
    if (zeroSuccessScore >= selfScore) {
      impact += params.zeroClimberPressure * (1 + Math.max(0, zeroSuccessScore - selfScore) / 20);
    }
  }
  if (selfScore < winnerScore) impact += params.protectTrailingSelf * (afterDistance > beforeDistance ? 1 : -0.5);
  return impact;
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
    if (lowMode) return entry.card.value < winner.card.value ? entry : winner;
    return entry.card.value > winner.card.value ? entry : winner;
  }, null);
  return best.seat;
}

function scoreRound(round, predicted, actual) {
  if (predicted === 0 && actual === 0) return round;
  if (predicted >= 1 && predicted === actual) return 2 * predicted;
  return -2 * Math.abs(predicted - actual);
}

function cardPower(card, params) {
  if (card.type === "death") return params.deathPower;
  if (card.type === "zero") return params.zeroPower;
  if (REVERSE_VALUES.has(card.value)) return params.reversePower;
  return card.value / params.normalPowerScale;
}

function mutateParams(params, random, iteration) {
  const scale = Math.max(0.06, 0.22 * (1 - iteration / Math.max(iterations, 1)));
  const next = { ...params };
  const ranges = {
    deathPredict: [0.4, 2.2],
    zeroPredictEarly: [0, 0.8],
    zeroPredictLate: [0, 1.1],
    reversePredict: [0, 1.2],
    high35Predict: [0.2, 1.6],
    high29Predict: [0.1, 1.3],
    high22Predict: [0, 1],
    lowCardPredict: [0, 0.7],
    earlyConservative: [0.45, 1.15],
    lateConservative: [0.4, 1.05],
    tryWinChance: [0.25, 0.95],
    winBonus: [0.8, 4],
    losePenalty: [-4, -0.5],
    reverseRisk: [-0.5, 0.8],
    deathAvoidPenalty: [-0.3, 1.5],
    zeroVsDeathBonus: [0, 3],
    deathPower: [1.2, 4],
    zeroPower: [-0.2, 1],
    reversePower: [0.2, 1.6],
    normalPowerScale: [24, 55],
    missGoalPenalty: [0, 8],
    forcedWinPenalty: [0, 5],
    burnPowerWhenSafe: [-0.5, 1.2],
    leaderSabotage: [0, 2.5],
    opponentFailPressure: [0, 2],
    protectTrailingSelf: [0, 1.5],
    zeroPredictionPressure: [0, 4],
    zeroClimberPressure: [0, 3]
  };

  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (random() > 0.65) continue;
    const width = max - min;
    next[key] = clamp(params[key] + gaussian(random) * width * scale, min, max);
  }
  return roundParams(next);
}

function roundParams(params) {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Number(value.toFixed(4))]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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

function scenarioPenalty(params) {
  let penalty = 0;
  const cases = [
    {
      expectedNot: "Death",
      context: {
        hand: [deathCard(), numberCard(3)],
        played: [scenarioPlay(1, numberCard(12)), scenarioPlay(2, numberCard(20)), scenarioPlay(3, zeroCard(1))],
        seat: 4,
        round: 2,
        trickNumber: 2,
        prediction: 1,
        actualWins: 0
      }
    },
    {
      expected: "Death",
      context: {
        hand: [deathCard(), numberCard(2)],
        played: [scenarioPlay(1, numberCard(31)), scenarioPlay(2, numberCard(4)), scenarioPlay(3, numberCard(8))],
        seat: 4,
        round: 5,
        trickNumber: 4,
        prediction: 2,
        actualWins: 1
      }
    },
    {
      expected: "35",
      context: {
        hand: [numberCard(2), numberCard(35), zeroCard(1)],
        played: [scenarioPlay(1, numberCard(22)), scenarioPlay(2, numberCard(19)), scenarioPlay(3, numberCard(7))],
        seat: 4,
        round: 5,
        trickNumber: 3,
        prediction: 1,
        actualWins: 1
      }
    }
  ];

  for (const item of cases) {
    const chosen = chooseCard({ ...item.context, params, random: () => 0.5 });
    if (item.expected && chosen.label !== item.expected) penalty += 3;
    if (item.expectedNot && chosen.label === item.expectedNot) penalty += 3;
  }
  return penalty;
}

function scenarioPlay(seat, card) {
  return { seat, card, order: 0 };
}

function numberCard(value) {
  return { id: `n-${value}`, type: "number", value, label: String(value) };
}

function zeroCard(copy) {
  return { id: `z-${copy}`, type: "zero", value: 0, label: "0" };
}

function deathCard() {
  return { id: "death", type: "death", value: null, label: "Death" };
}

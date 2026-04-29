import params from "../src/bot-params.json" with { type: "json" };

const PLAYER_COUNT = 5;
const FINAL_ROUND = 9;
const REVERSE_VALUES = new Set([11, 22, 33]);
const GAMES = Number(process.argv.find((arg) => arg.startsWith("--games="))?.split("=")[1] ?? 8000);
const seedArg = Number(process.argv.find((arg) => arg.startsWith("--seed="))?.split("=")[1] ?? 24681357);
const lookaheadPressure = Number(process.argv.find((arg) => arg.startsWith("--pressure="))?.split("=")[1] ?? 3.2);
const lookaheadMinRound = Number(process.argv.find((arg) => arg.startsWith("--min-round="))?.split("=")[1] ?? 5);
const setupPressure = Number(process.argv.find((arg) => arg.startsWith("--setup-pressure="))?.split("=")[1] ?? 2.2);
const setupMinRound = Number(process.argv.find((arg) => arg.startsWith("--setup-min-round="))?.split("=")[1] ?? 6);

function runSuite() {
  const baseline = runSimulation({ lookahead: false, setup: false, seed: seedArg });
  const lookahead = runSimulation({ lookahead: true, setup: false, seed: seedArg });
  const setup = runSimulation({ lookahead: true, setup: true, seed: seedArg });

  printSummary("Baseline", baseline);
  printSummary("Lookahead", lookahead);
  printSummary("Lookahead + setup sacrifice", setup);
  printDelta("Delta, lookahead - baseline", baseline, lookahead);
  printDelta("Delta, setup - baseline", baseline, setup);
  printDelta("Delta, setup - lookahead", lookahead, setup);
}

function printDelta(title, from, to) {
  console.log(`\n${title}:`);
  for (let round = 1; round <= FINAL_ROUND; round += 1) {
    const b = from.rounds[round];
    const l = to.rounds[round];
    console.log(
      [
        `R${round}`,
        `zeroSuccess ${(percent(l.zeroSuccess, l.zeroPred) - percent(b.zeroSuccess, b.zeroPred)).toFixed(1)} pts`,
        `zeroEV ${(avg(l.zeroScore, l.zeroPred) - avg(b.zeroScore, b.zeroPred)).toFixed(2)}`,
        `scoreEV ${(avg(l.score, l.total) - avg(b.score, b.total)).toFixed(2)}`
      ].join(" | ")
    );
  }
}

function runSimulation({ lookahead, setup, seed }) {
  const random = makeRng(seed);
  const rounds = Array.from({ length: FINAL_ROUND + 1 }, () => ({
    total: 0,
    score: 0,
    zeroPred: 0,
    zeroSuccess: 0,
    zeroScore: 0,
    lookaheadTriggers: 0,
    setupTriggers: 0
  }));

  for (let game = 0; game < GAMES; game += 1) {
    const scores = Array(PLAYER_COUNT).fill(0);
    for (let round = 1; round <= FINAL_ROUND; round += 1) {
      const hands = deal(round, random);
      const predictions = hands.map((hand) => predict(hand, round));
      const actualWins = Array(PLAYER_COUNT).fill(0);
      let leaderSeat = Math.floor(random() * PLAYER_COUNT);

      for (let trickNumber = 1; trickNumber <= round; trickNumber += 1) {
        const played = [];
        for (const seat of seatOrderFrom(leaderSeat)) {
          const pick = chooseCard({
            hand: hands[seat],
            allHands: hands,
            played,
            seat,
            round,
            trickNumber,
            prediction: predictions[seat],
            actualWins: actualWins[seat],
            predictions,
            actualWinsBySeat: actualWins,
            scores,
            random,
            lookahead,
            setup
          });
          if (pick.lookaheadBonus > 0) rounds[round].lookaheadTriggers += 1;
          if (pick.setupBonus > 0) rounds[round].setupTriggers += 1;
          hands[seat].splice(hands[seat].findIndex((entry) => entry.id === pick.card.id), 1);
          played.push({ seat, card: pick.card, order: played.length });
        }
        leaderSeat = determineTrickWinner(played);
        actualWins[leaderSeat] += 1;
      }

      for (let seat = 0; seat < PLAYER_COUNT; seat += 1) {
        const delta = scoreRound(round, predictions[seat], actualWins[seat]);
        scores[seat] += delta;
        rounds[round].total += 1;
        rounds[round].score += delta;
        if (predictions[seat] === 0) {
          rounds[round].zeroPred += 1;
          rounds[round].zeroScore += delta;
          if (actualWins[seat] === 0) rounds[round].zeroSuccess += 1;
        }
      }
    }
  }

  return { rounds };
}

function printSummary(name, result) {
  console.log(`\n== ${name} ==`);
  console.log("round | zeroPred | zeroSuccess% | zeroEV | scoreEV | lookaheadTriggers | setupTriggers");
  for (let round = 1; round <= FINAL_ROUND; round += 1) {
    const row = result.rounds[round];
    console.log(
      [
        round,
        row.zeroPred,
        `${percent(row.zeroSuccess, row.zeroPred).toFixed(1)}%`,
        avg(row.zeroScore, row.zeroPred).toFixed(2),
        avg(row.score, row.total).toFixed(2),
        row.lookaheadTriggers,
        row.setupTriggers
      ].join(" | ")
    );
  }
}

function predict(hand, round) {
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

function chooseCard({ hand, allHands, played, seat, round, trickNumber, prediction, actualWins, predictions, actualWinsBySeat, scores, random, lookahead, setup }) {
  const remainingAfterThis = Math.max(0, round - trickNumber);
  const needWins = prediction - actualWins;
  const shouldTryWin = needWins > 0 && (needWins >= remainingAfterThis || random() < params.tryWinChance);
  const scored = hand.map((card) => {
    const projected = [...played, { seat, card, order: played.length }];
    const winnerIfPlayed = determineTrickWinner(projected);
    const currentlyWinning = winnerIfPlayed === seat;
    const power = cardPower(card);
    const reverseRisk = card.type === "number" && REVERSE_VALUES.has(card.value) ? params.reverseRisk : 0;
    const deathBonus = card.type === "death" ? params.deathAvoidPenalty : 0;
    const zeroVsDeathBonus = card.type === "zero" && played.some((entry) => entry.card.type === "death") ? params.zeroVsDeathBonus : 0;
    const opponentImpact = scoreOpponentImpact({ seat, winnerSeat: winnerIfPlayed, round, predictions, actualWinsBySeat, scores });
    const lookaheadBonus = lookahead ? zeroLookaheadBonus({ allHands, projected, seat, round, predictions, actualWinsBySeat, scores }) : 0;

    const base = shouldTryWin
      ? (currentlyWinning ? params.winBonus + power + zeroVsDeathBonus - reverseRisk : -params.missGoalPenalty - power) + opponentImpact
      : (currentlyWinning ? params.losePenalty - params.forcedWinPenalty : 0) - power + power * params.burnPowerWhenSafe - deathBonus + reverseRisk + opponentImpact;

    return { card, base, lookaheadBonus, currentlyWinning };
  });

  const hasDirectZeroPressure = scored.some((entry) => entry.lookaheadBonus > 0);
  const finalized = scored.map((entry) => {
    const setupBonus = setup && !hasDirectZeroPressure
      ? setupPressureBonus({ seat, round, prediction, actualWins, currentlyWinning: entry.currentlyWinning, predictions, actualWinsBySeat, scores })
      : 0;
    const jitter = (random() - 0.5) * 0.03;
    return {
      ...entry,
      setupBonus,
      score: entry.base + entry.lookaheadBonus + setupBonus + jitter
    };
  });
  finalized.sort((a, b) => b.score - a.score);
  return finalized[0];
}

function setupPressureBonus({ seat, round, prediction, actualWins, currentlyWinning, predictions, actualWinsBySeat, scores }) {
  if (!currentlyWinning || round < setupMinRound) return 0;
  const selfScore = scores[seat] || 0;
  const selfMissCost = prediction === actualWins ? Math.max(2, round / 2) : 0;
  let bestSetup = 0;

  for (let targetSeat = 0; targetSeat < PLAYER_COUNT; targetSeat += 1) {
    if (targetSeat === seat) continue;
    if (predictions[targetSeat] !== 0 || (actualWinsBySeat[targetSeat] || 0) > 0) continue;

    const targetScore = scores[targetSeat] || 0;
    const targetThreatScore = targetScore + round;
    const targetIsDangerous = targetScore > selfScore || targetThreatScore >= selfScore;
    if (!targetIsDangerous) continue;

    const targetOrderIfLeadNext = relativeSeat(targetSeat, seat);
    if (targetOrderIfLeadNext < 3) continue;

    const orderWeight = targetOrderIfLeadNext / 4;
    const swing = round + 2;
    const scoreThreat = 1 + Math.max(0, targetThreatScore - selfScore) / 18;
    const value = (swing * orderWeight * scoreThreat * setupPressure) / 6 - selfMissCost * 0.55;
    bestSetup = Math.max(bestSetup, value);
  }

  return Math.max(0, bestSetup);
}

function zeroLookaheadBonus({ allHands, projected, seat, round, predictions, actualWinsBySeat, scores }) {
  if (round < lookaheadMinRound) return 0;
  let bonus = 0;
  for (const targetSeat of remainingSeatsAfter(projected, seat)) {
    if (predictions[targetSeat] !== 0 || (actualWinsBySeat[targetSeat] || 0) > 0) continue;
    const targetHand = allHands[targetSeat] || [];
    if (!targetHand.length) continue;

    const winningCards = targetHand.filter((card) => determineTrickWinner([...projected, { seat: targetSeat, card, order: projected.length }]) === targetSeat).length;
    if (winningCards === 0) continue;

    const forcedRatio = winningCards / targetHand.length;
    const selfScore = scores[seat] || 0;
    const targetScore = scores[targetSeat] || 0;
    const leaderWeight = 1 + Math.max(0, targetScore - selfScore) / 18;
    const climberWeight = targetScore + round >= selfScore ? 1.4 : 1;
    const lateWeight = 1 + round / FINAL_ROUND;
    bonus += forcedRatio * lateWeight * leaderWeight * climberWeight * lookaheadPressure;
  }
  return bonus;
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

function scoreOpponentImpact({ seat, winnerSeat, round, predictions, actualWinsBySeat, scores }) {
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

function determineTrickWinner(played) {
  const reverseCount = played.filter(({ card }) => card.type === "number" && REVERSE_VALUES.has(card.value)).length;
  const lowMode = reverseCount % 2 === 1;
  const zeros = played.filter(({ card }) => card.type === "zero");
  const death = played.find(({ card }) => card.type === "death");

  if (death) {
    if (zeros.length > 0) return zeros[0].seat;
    return death.seat;
  }

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
  if (card.type === "death") return params.deathPower;
  if (card.type === "zero") return params.zeroPower;
  if (REVERSE_VALUES.has(card.value)) return params.reversePower;
  return card.value / params.normalPowerScale;
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

runSuite();

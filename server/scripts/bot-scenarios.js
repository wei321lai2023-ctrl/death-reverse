import botParams from "../src/bot-params.json" with { type: "json" };

const REVERSE_VALUES = new Set([11, 22, 33]);

const scenarios = [
  {
    name: "Needs a win, but 0 already beats Death",
    seat: 4,
    round: 2,
    trickNumber: 2,
    prediction: 1,
    actualWins: 0,
    played: [
      play(1, number(12)),
      play(2, number(20)),
      play(3, zero(1))
    ],
    hand: [death(), number(3)],
    note: "This catches the annoying case where Death cannot win because 0 is already on table."
  },
  {
    name: "Already hit prediction, may want to burn power",
    seat: 4,
    round: 5,
    trickNumber: 4,
    prediction: 2,
    actualWins: 2,
    played: [
      play(1, number(31)),
      play(2, number(4)),
      play(3, number(8))
    ],
    hand: [death(), number(2)],
    note: "Sometimes burning Death can be reasonable if keeping it makes a future unwanted win likely."
  },
  {
    name: "Needs a win and Death can currently win",
    seat: 4,
    round: 5,
    trickNumber: 4,
    prediction: 2,
    actualWins: 1,
    played: [
      play(1, number(31)),
      play(2, number(4)),
      play(3, number(8))
    ],
    hand: [death(), number(2)],
    note: "Basic case: if bot still needs a win and Death works, spending it is understandable."
  },
  {
    name: "Wants to lose after a reverse flips to low mode",
    seat: 4,
    round: 5,
    trickNumber: 3,
    prediction: 1,
    actualWins: 1,
    played: [
      play(1, number(22)),
      play(2, number(19)),
      play(3, number(7))
    ],
    hand: [number(2), number(35), zero(1)],
    note: "Low mode means smaller normal cards are dangerous."
  },
  {
    name: "Pressure leader into over-winning",
    seat: 4,
    round: 8,
    trickNumber: 6,
    prediction: 2,
    actualWins: 2,
    predictions: [1, 2, 3, 1, 2],
    actualWinsBySeat: [1, 2, 3, 1, 2],
    scores: [4, 18, 6, 2, 5],
    played: [
      play(1, number(31)),
      play(2, number(14)),
      play(3, number(9))
    ],
    hand: [number(2), death()],
    note: "Seat 2 is leading and already hit prediction. Letting them win one more can make them miss."
  },
  {
    name: "Avoid helping leader reach prediction",
    seat: 4,
    round: 8,
    trickNumber: 5,
    prediction: 2,
    actualWins: 2,
    predictions: [1, 2, 3, 1, 2],
    actualWinsBySeat: [1, 1, 3, 1, 2],
    scores: [4, 18, 6, 2, 5],
    played: [
      play(1, number(31)),
      play(2, number(14)),
      play(3, number(9))
    ],
    hand: [number(2), death()],
    note: "Seat 2 is leading but still needs one. Helping them win is bad."
  },
  {
    name: "Break a zero prediction before it pays",
    seat: 4,
    round: 7,
    trickNumber: 4,
    prediction: 1,
    actualWins: 1,
    predictions: [1, 0, 2, 1, 1],
    actualWinsBySeat: [1, 0, 2, 1, 1],
    scores: [4, 11, 5, 2, 8],
    played: [
      play(1, number(28)),
      play(2, number(14)),
      play(3, number(9))
    ],
    hand: [number(2), death()],
    note: "Seat 2 predicted 0. Letting them win this trick breaks a high-value zero prediction."
  },
  {
    name: "Prefer pressure against a late zero predictor",
    seat: 1,
    round: 8,
    trickNumber: 3,
    prediction: 1,
    actualWins: 0,
    predictions: [2, 1, 2, 0, 1],
    actualWinsBySeat: [1, 0, 1, 0, 1],
    scores: [6, 4, 8, 18, 7],
    played: [play(0, number(18))],
    hand: [number(21), number(38), death()],
    note: "Seat 4 predicted 0 and is dangerous. The bot should value plays that make their later position more awkward."
  }
];

for (const scenario of scenarios) {
  const result = analyzeScenario(scenario);
  console.log("\n== " + scenario.name + " ==");
  console.log(scenario.note);
  console.log(`Prediction: ${scenario.prediction}, actual wins: ${scenario.actualWins}, need: ${result.needWins}`);
  console.log(`Mode if unchanged: ${result.lowMode ? "low card" : "high card"}`);
  console.log(`Played: ${scenario.played.map((entry) => `S${entry.seat + 1}:${entry.card.label}`).join("  ")}`);
  console.log(`Hand: ${scenario.hand.map((card) => card.label).join(", ")}`);
  console.table(result.options);
  console.log(`Chosen: ${result.chosen.card}`);
}

function analyzeScenario(scenario) {
  const needWins = scenario.prediction - scenario.actualWins;
  const remainingAfterThis = Math.max(0, scenario.round - scenario.trickNumber);
  const shouldTryWin = needWins > 0 && (needWins >= remainingAfterThis || 0.5 < botParams.tryWinChance);
  const options = scenario.hand.map((card) => {
    const projected = [...scenario.played, { seat: scenario.seat, card, order: scenario.played.length }];
    const winningSeat = determineTrickWinner(projected);
    const currentlyWinning = winningSeat === scenario.seat;
    const power = cardPower(card);
    const reverseRisk = card.type === "number" && REVERSE_VALUES.has(card.value) ? botParams.reverseRisk : 0;
    const deathBonus = card.type === "death" ? botParams.deathAvoidPenalty : 0;
    const zeroVsDeathBonus = card.type === "zero" && scenario.played.some((entry) => entry.card.type === "death") ? botParams.zeroVsDeathBonus : 0;
    const opponentImpact = scoreOpponentImpact(scenario, winningSeat);
    const score = shouldTryWin
      ? currentlyWinning ? botParams.winBonus + power + zeroVsDeathBonus - reverseRisk : -botParams.missGoalPenalty - power
      : (currentlyWinning ? botParams.losePenalty - botParams.forcedWinPenalty : 0) - power + power * botParams.burnPowerWhenSafe - deathBonus + reverseRisk + opponentImpact;
    return {
      card: card.label,
      winsNow: currentlyWinning,
      winnerIfPlayed: `S${winningSeat + 1}`,
      power: round(power),
      opponentImpact: round(opponentImpact),
      score: round(score)
    };
  });
  options.sort((a, b) => b.score - a.score);
  return {
    needWins,
    shouldTryWin,
    lowMode: countReverse(scenario.played) % 2 === 1,
    options,
    chosen: options[0]
  };
}

function scoreOpponentImpact(scenario, winnerSeat) {
  if (winnerSeat === scenario.seat || !scenario.predictions) return 0;
  const selfScore = scenario.scores?.[scenario.seat] || 0;
  const winnerScore = scenario.scores?.[winnerSeat] || 0;
  const beforeWins = scenario.actualWinsBySeat?.[winnerSeat] || 0;
  const afterWins = beforeWins + 1;
  const prediction = scenario.predictions[winnerSeat];
  const beforeDistance = Math.abs(prediction - beforeWins);
  const afterDistance = Math.abs(prediction - afterWins);
  const scoreLead = Math.max(0, winnerScore - selfScore);
  const leadWeight = 1 + scoreLead / 20;
  let impact = 0;

  if (afterDistance > beforeDistance) impact += botParams.opponentFailPressure * leadWeight;
  else if (afterDistance < beforeDistance) impact -= botParams.opponentFailPressure * leadWeight;

  if (scoreLead > 0 && afterDistance > beforeDistance) impact += botParams.leaderSabotage * leadWeight;
  if (prediction === 0 && beforeWins === 0) {
    const lateRoundWeight = 1 + scenario.round / 9;
    const zeroSuccessScore = winnerScore + scenario.round;
    impact += botParams.zeroPredictionPressure * lateRoundWeight * leadWeight;
    if (zeroSuccessScore >= selfScore) {
      impact += botParams.zeroClimberPressure * (1 + Math.max(0, zeroSuccessScore - selfScore) / 20);
    }
  }
  if (selfScore < winnerScore) impact += botParams.protectTrailingSelf * (afterDistance > beforeDistance ? 1 : -0.5);
  return impact;
}

function determineTrickWinner(played) {
  const reverseCount = countReverse(played);
  const lowMode = reverseCount % 2 === 1;
  const zeros = played.filter(({ card }) => card.type === "zero");
  const deathCard = played.find(({ card }) => card.type === "death");

  if (deathCard) {
    if (zeros.length > 0) return zeros[0].seat;
    return deathCard.seat;
  }

  const best = played.reduce((winner, entry) => {
    if (!winner) return entry;
    if (lowMode) return entry.card.value < winner.card.value ? entry : winner;
    return entry.card.value > winner.card.value ? entry : winner;
  }, null);
  return best.seat;
}

function cardPower(card) {
  if (card.type === "death") return botParams.deathPower;
  if (card.type === "zero") return botParams.zeroPower;
  if (REVERSE_VALUES.has(card.value)) return botParams.reversePower;
  return card.value / botParams.normalPowerScale;
}

function countReverse(played) {
  return played.filter(({ card }) => card.type === "number" && REVERSE_VALUES.has(card.value)).length;
}

function play(seat, card) {
  return { seat, card, order: 0 };
}

function number(value) {
  return { id: `n-${value}`, type: "number", value, label: String(value) };
}

function zero(copy) {
  return { id: `z-${copy}`, type: "zero", value: 0, label: "0" };
}

function death() {
  return { id: "death", type: "death", value: null, label: "Death" };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

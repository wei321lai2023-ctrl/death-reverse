# Death Reverse Rules

## Basic Setup

- The game is played by exactly 5 players.
- Each room has 5 fixed seats.
- Turn order is clockwise by seat order.
- A full game has 9 rounds.
- In round R, each player receives R cards.
  - Round 1: 1 card per player
  - Round 2: 2 cards per player
  - ...
  - Round 9: 9 cards per player

## Deck

The deck has 45 cards total:

- Number cards: 1 to 39, one copy each
- Zero cards: 0, five copies
- Death card: one copy

## Round Flow

Each round follows this order:

1. The server shuffles and deals cards.
2. Each player predicts how many tricks they will win this round.
3. Predictions are submitted secretly.
4. After all players submit, non-hidden predictions are revealed.
5. Players play R tricks.
6. The first trick leader is random.
7. Later trick leaders are the winners of the previous trick.
8. After each trick, the played cards and trick winner are shown.
9. All human players click continue before the next trick starts.
10. After all tricks in the round are finished, scores are calculated.
11. All human players click continue before the next round is dealt.
12. After round 9, the player with the highest total score wins.

## Prediction Rules

- In round R, a player may predict any number from 0 to R.
- Each player may hide their prediction once per full game.
- A player can choose any round to use their hidden prediction.
- Hidden predictions are revealed at the end of that round for scoring.
- Since hiding is per player, multiple players may hide in the same round.

## Trick Play

- The leader plays first.
- Other players play clockwise after the leader.
- Every player plays exactly one card per trick.
- The server validates turn order.
- The trick winner leads the next trick.

## Card Power Rules

### Reverse Cards

The reverse cards are:

- 11
- 22
- 33

Each reverse card played in a trick toggles the comparison mode once.

- 0 reverse cards: high card mode
- 1 reverse card: low card mode
- 2 reverse cards: high card mode
- 3 reverse cards: low card mode

### Death Card

- Death beats all normal number cards.
- Death is not affected by reverse mode.
- Death wins in both high card mode and low card mode.
- Exception: if one or more 0 cards are played in the same trick, 0 beats Death.

### 0 Cards

0 is not always the strongest card.

0 can win in these cases:

- Low card mode, because 0 is the lowest number.
- Any trick where Death is played, because 0 beats Death.

If more than one 0 card can win, the earliest played 0 wins the trick.

In high card mode without Death, 0 is just the lowest number and usually loses.

## Trick Winner Priority

To determine a trick winner:

1. Count reverse cards to decide high card mode or low card mode.
2. If Death was played:
   - If any 0 was also played, the earliest 0 wins.
   - Otherwise, Death wins.
3. If no Death was played:
   - In high card mode, the highest number wins.
   - In low card mode, the lowest number wins.
   - If multiple 0 cards win in low card mode, the earliest 0 wins.

## Scoring

Let:

- R = current round number
- P = predicted wins
- A = actual wins

Scoring:

- If P = 0 and A = 0: score +R
- If P >= 1 and P = A: score +2 × P
- If prediction fails: score -2 × abs(P - A)

Scores are cumulative across all 9 rounds.

## Winning

After round 9:

- The player with the highest total score wins.
- If players are tied, they are shown with the same final score. The current MVP does not add a special tiebreaker.

## Online Play

- One player creates a room.
- The room code is shared with the other 4 players.
- All 5 players join the same room.
- Everyone clicks Ready.
- The game starts automatically when all 5 seats are filled and all 5 players are Ready.

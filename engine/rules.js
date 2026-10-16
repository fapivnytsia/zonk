// Zonk scoring. Pure functions, no I/O.

export const DICE = 6;

const STRAIGHT = 1500;    // 1-2-3-4-5-6 in one roll
const THREE_PAIRS = 750;  // three different pairs in one roll

export const roll = (n, rnd = Math.random) => Array.from({ length: n }, () => 1 + Math.floor(rnd() * 6));

const countFaces = dice => {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d]++;
  return counts;
};

const isStraight = counts => counts.slice(1).every(c => c === 1);
const isThreePairs = counts => counts.filter(c => c === 2).length === 3;

// Three of a kind is face × 100 (three ones are 1000), every extra die doubles it
const setPoints = (face, count) => (face === 1 ? 1000 : face * 100) * 2 ** (count - 3);

// Points for a set of dice put aside: 0 for no dice, null if any die in it scores nothing.
// A one is 100, a five is 50.
export function scoreDice(dice) {
  if (!dice.length) return 0;
  const counts = countFaces(dice);

  if (dice.length === DICE) {
    if (isStraight(counts)) return STRAIGHT;
    if (isThreePairs(counts)) return THREE_PAIRS;
  }

  let score = 0;
  for (let face = 1; face <= 6; face++) {
    const c = counts[face];
    if (c >= 3) score += setPoints(face, c);
    else if (face === 1) score += 100 * c;
    else if (face === 5) score += 50 * c;
    else if (c) return null;
  }
  return score;
}

// scoreDice of every choice of dice from a roll: scores[mask] is for the dice whose bits are set.
// The mini app prices any choice from this without asking the bot.
export const subsetScores = dice =>
  Array.from({ length: 1 << dice.length }, (_, mask) => scoreDice(dice.filter((_, i) => (mask >> i) & 1)));

const bitCount = mask => mask.toString(2).replace(/0/g, "").length;
const maskIndices = (mask, n) => Array.from({ length: n }, (_, i) => i).filter(i => (mask >> i) & 1);

// The most points a roll can give and which dice give them (fewest dice on a tie). score 0 is a zonk.
export function bestPick(dice) {
  const scores = subsetScores(dice);
  let best = 0;
  for (let mask = 1; mask < scores.length; mask++) {
    if (scores[mask] > scores[best] || (scores[mask] && scores[mask] === scores[best] && bitCount(mask) < bitCount(best))) {
      best = mask;
    }
  }
  return { score: scores[best], picked: maskIndices(best, dice.length) };
}

// Dice that can be part of some scoring choice: the page highlights them and dims the rest
export function scoringDice(dice) {
  const scores = subsetScores(dice);
  let any = 0;
  scores.forEach((score, mask) => {
    if (score) any |= mask;
  });
  return maskIndices(any, dice.length);
}

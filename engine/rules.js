// Zonk scoring. Pure functions, no I/O.

export const DICE = 6;

const STRAIGHT = 1500;    // 1-2-3-4-5-6
const SMALL_LOW = 500;    // 1-2-3-4-5
const SMALL_HIGH = 750;   // 2-3-4-5-6
const THREE_PAIRS = 750;  // three different pairs
const FULL_HOUSE = 1000;  // three of one face and two of another

export const roll = (n, rnd = Math.random) => Array.from({ length: n }, () => 1 + Math.floor(rnd() * 6));

const countFaces = dice => {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d]++;
  return counts;
};

// Three of a kind is face × 100 (three ones are 1000), every extra die doubles it
const setPoints = (face, count) => (face === 1 ? 1000 : face * 100) * 2 ** (count - 3);

// Every scoring group that can be taken out of these counts: [dice it uses by face, points]
function groups(c) {
  const out = [];
  const has = (from, to) => c.slice(from, to + 1).every(n => n >= 1);
  const run = (from, to) => c.map((_, f) => (f >= from && f <= to ? 1 : 0));
  if (has(1, 6)) out.push([run(1, 6), STRAIGHT]);
  if (has(1, 5)) out.push([run(1, 5), SMALL_LOW]);
  if (has(2, 6)) out.push([run(2, 6), SMALL_HIGH]);

  const pairs = [1, 2, 3, 4, 5, 6].filter(f => c[f] >= 2);
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++)
      for (let k = j + 1; k < pairs.length; k++) {
        const use = [0, 0, 0, 0, 0, 0, 0];
        use[pairs[i]] = use[pairs[j]] = use[pairs[k]] = 2;
        out.push([use, THREE_PAIRS]);
      }

  for (let a = 1; a <= 6; a++) {
    if (c[a] < 3) continue;
    for (let b = 1; b <= 6; b++) {
      if (b === a || c[b] < 2) continue;
      const use = [0, 0, 0, 0, 0, 0, 0];
      use[a] = 3;
      use[b] = 2;
      out.push([use, FULL_HOUSE]);
    }
    for (let n = 3; n <= c[a]; n++) {
      const use = [0, 0, 0, 0, 0, 0, 0];
      use[a] = n;
      out.push([use, setPoints(a, n)]);
    }
  }

  if (c[1]) out.push([[0, 1, 0, 0, 0, 0, 0], 100]);
  if (c[5]) out.push([[0, 0, 0, 0, 0, 1, 0], 50]);
  return out;
}

// The most points for using up all these dice, or null if some can't be used
function bestSplit(c, memo) {
  if (c.every(n => n === 0)) return 0;
  const key = c.join("");
  if (memo.has(key)) return memo.get(key);
  let top = null;
  for (const [use, points] of groups(c)) {
    const rest = bestSplit(c.map((n, f) => n - use[f]), memo);
    if (rest !== null && (top === null || points + rest > top)) top = points + rest;
  }
  memo.set(key, top);
  return top;
}

// Points for a set of dice put aside: 0 for no dice, null if any die in it scores nothing.
// The dice are split into groups the best way: a one is 100, a five is 50, three or more of a kind,
// straights 1-5 / 2-6 / 1-6, three pairs, a full house (3 + 2). 1-1-1-5-5 is 1000 + 100, not a full house.
export function scoreDice(dice) {
  if (!dice.length) return 0;
  return bestSplit(countFaces(dice), new Map());
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

import { scoreDice } from "./rules.js";

// The computer opponent's choice for one roll.

// Rough worth of the dice still in hand: more dice left means a safer next roll
const DICE_WORTH = { 6: 520, 5: 300, 4: 170, 3: 90, 2: 40, 1: 15 };
// With this many dice left the bot stops once the turn is worth this much (× temper)
const STOP_AT = { 1: 300, 2: 350, 3: 450, 4: 750, 5: 1700 };
const TEMPER = { calm: 0.85, bold: 1.4 };

// dice: the roll, turn: points already aside this turn.
// ctx: { target, temper, minBank, mine, theirs } — mine/theirs are the totals of the bot and the player.
// Returns { idx, s, left, bank }: which dice to take, their points, dice left to roll, and whether to stop.
export function botChoose(dice, turn, ctx) {
  const n = dice.length;
  const opts = [];
  for (let m = 1; m < 1 << n; m++) {
    const idx = [];
    for (let i = 0; i < n; i++) if ((m >> i) & 1) idx.push(i);
    const s = scoreDice(idx.map(i => dice[i]));
    if (s > 0) opts.push({ idx, s, left: n - idx.length || 6 });
  }
  const need = ctx.target - ctx.mine;
  const theirNeed = ctx.target - ctx.theirs;
  const top = [...opts].sort((a, b) => b.s - a.s || a.idx.length - b.idx.length)[0];

  if (turn + top.s >= need && turn + top.s >= ctx.minBank) return { ...top, bank: true };

  const best = opts.reduce((a, o) => (o.s + DICE_WORTH[o.left] > a.s + DICE_WORTH[a.left] ? o : a));
  if (best.left === 6) return { ...best, bank: false };
  if (top.left === 6) return { ...top, bank: false };

  let k = TEMPER[ctx.temper] ?? TEMPER.calm;
  if (theirNeed <= 1000) k *= 1.7;
  else if (ctx.mine - ctx.theirs > ctx.target * 0.3) k *= 0.8;

  if (turn + top.s >= ctx.minBank && turn + best.s >= STOP_AT[best.left] * k) return { ...top, bank: true };
  return { ...best, bank: false };
}

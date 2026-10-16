import { DICE, roll, scoreDice, bestPick } from "./rules.js";
import { botChoose } from "./bot.js";

// A Zonk game as a plain object that is saved as JSON. Pure logic, no I/O.
//
// players[] take turns, players[cur] moves now; a bot player plays its whole turn at once.
// A duel later is just two human players in players[].
// Every move fills `ev` with what happened, in order, so the page can animate it:
//   { t: "turn", p, round? }       a turn starts with an empty tray
//   { t: "roll", p, dice }         dice thrown
//   { t: "pick", p, idx, s, bank, total }  the bot chose dice (and whether it stops)
//   { t: "take", p, idx, s }       dice at idx put aside for s points
//   { t: "hot", p }                all six scored, all six are thrown again
//   { t: "zonk", p, lost }         a roll with no points, the turn's points burn
//   { t: "bank", p, gain, total }  the turn's points written to the total
//   { t: "end" }                   the game is over

export const MODES = { bot: "против бота", score: "на очки" };

// Against the bot: a race to the target, a turn is written only from MIN_BANK points
export const TARGETS = [2000, 5000, 10000];
export const TEMPERS = { calm: "осторожный", bold: "азартный" };
export const MIN_BANK = 300;
export const BOT_WIN_MULT = 2; // stake multiplier for a win

// On points: ROUNDS turns alone, the payout for the total is the first row that fits
export const ROUNDS = 10;
export const SCORE_PAYOUT = [
  { from: 8000, mult: 5 },
  { from: 7000, mult: 3 },
  { from: 6000, mult: 2 },
  { from: 5000, mult: 1.5 },
  { from: 4500, mult: 1 },
  { from: 3500, mult: 0.5 },
  { from: 0, mult: 0 },
];

// opts: { mode: "bot", target, temper } or { mode: "score" }. user: { id, name }.
// null if opts are wrong. Who starts against the bot is a coin toss, the bot may already move here.
export function newGame(opts, user, ev, rnd = Math.random) {
  const me = { id: user.id, name: user.name, total: 0 };
  let s;
  if (opts.mode === "bot") {
    if (!TARGETS.includes(opts.target) || !TEMPERS[opts.temper]) return null;
    s = {
      mode: "bot", target: opts.target, temper: opts.temper,
      players: [me, { id: 0, name: "Бот", bot: true, total: 0 }],
      cur: rnd() < 0.5 ? 0 : 1,
    };
  } else if (opts.mode === "score") {
    s = { mode: "score", round: 1, players: [me], cur: 0 };
  } else {
    return null;
  }
  Object.assign(s, { dice: [], aside: [], turnPts: 0, rollNo: 0, done: false, winner: null });
  startTurn(s, ev, rnd);
  return s;
}

const minBank = s => (s.mode === "bot" ? MIN_BANK : 0);

function startTurn(s, ev, rnd) {
  s.dice = [];
  s.aside = [];
  s.turnPts = 0;
  s.rollNo++;
  ev.push({ t: "turn", p: s.cur, ...(s.mode === "score" && { round: s.round }) });
  if (s.players[s.cur].bot) botTurn(s, ev, rnd);
}

function endTurn(s, ev, rnd) {
  if (s.mode === "score") {
    s.round++;
    if (s.round > ROUNDS) return finish(s, ev);
  } else {
    s.cur = (s.cur + 1) % s.players.length;
  }
  startTurn(s, ev, rnd);
}

function finish(s, ev) {
  s.done = true;
  s.dice = [];
  ev.push({ t: "end" });
}

// Throws n dice. No points in them is a zonk and the turn passes. Returns false on a zonk.
function throwDice(s, n, ev, rnd) {
  s.dice = roll(n, rnd);
  s.rollNo++;
  ev.push({ t: "roll", p: s.cur, dice: s.dice });
  if (bestPick(s.dice).score) return true;

  ev.push({ t: "zonk", p: s.cur, lost: s.turnPts });
  s.turnPts = 0;
  endTurn(s, ev, rnd);
  return false;
}

// Puts the dice at idx aside. Returns the dice left to throw (all six again if none are left).
function take(s, idx, points, ev) {
  const set = new Set(idx);
  s.turnPts += points;
  s.aside.push({ vals: idx.map(i => s.dice[i]).sort((a, b) => a - b), s: points });
  s.dice = s.dice.filter((_, i) => !set.has(i));
  ev.push({ t: "take", p: s.cur, idx, s: points });
  if (s.dice.length) return s.dice.length;
  ev.push({ t: "hot", p: s.cur });
  return DICE;
}

function bankTurn(s, ev, rnd) {
  const p = s.players[s.cur];
  const gain = s.turnPts;
  p.total += gain;
  s.turnPts = 0;
  ev.push({ t: "bank", p: s.cur, gain, total: p.total });
  if (s.mode === "bot" && p.total >= s.target) {
    s.winner = s.cur;
    return finish(s, ev);
  }
  endTurn(s, ev, rnd);
}

function botTurn(s, ev, rnd) {
  const me = s.cur;
  const them = (me + 1) % s.players.length;
  let n = DICE;
  for (;;) {
    if (!throwDice(s, n, ev, rnd)) return;
    const d = botChoose(s.dice, s.turnPts, {
      target: s.target, temper: s.temper, minBank: minBank(s),
      mine: s.players[me].total, theirs: s.players[them].total,
    });
    ev.push({ t: "pick", p: me, idx: d.idx, s: d.s, bank: d.bank, total: s.turnPts + d.s });
    n = take(s, d.idx, d.s, ev);
    if (d.bank) return bankTurn(s, ev, rnd);
  }
}

// The dice the player chose: their points, or an error text
function checkPick(s, picked) {
  const ok =
    Array.isArray(picked) && picked.length > 0 &&
    picked.every(i => Number.isInteger(i) && i >= 0 && i < s.dice.length) &&
    new Set(picked).size === picked.length;
  if (!ok) return { error: "Отметь кости, которые дают очки." };
  const points = scoreDice(picked.map(i => s.dice[i]));
  if (!points) return { error: "Эти кости не дают очков." };
  return { idx: [...picked].sort((a, b) => a - b), points };
}

// A move of the player whose turn it is: "roll" (the first throw of a turn, or put picked aside and throw
// the rest) or "bank" (put picked aside and write the turn). Returns an error text, or nothing if made.
export function act(s, action, picked, ev, rnd = Math.random) {
  if (s.done) return "Партия уже закончилась.";
  if (action === "roll" && !s.dice.length) {
    throwDice(s, DICE, ev, rnd);
    return;
  }
  if (!s.dice.length) return "Сначала брось кости.";
  if (action !== "roll" && action !== "bank") return "Нет такого хода.";

  const pick = checkPick(s, picked);
  if (pick.error) return pick.error;
  if (action === "bank" && s.turnPts + pick.points < minBank(s)) return `Записать можно от ${minBank(s)} за ход.`;

  const n = take(s, pick.idx, pick.points, ev);
  if (action === "bank") bankTurn(s, ev, rnd);
  else throwDice(s, n, ev, rnd);
}

// What the page sees: no ids, the player's choice of dice stays on the page until a move
export function publicState(s) {
  return {
    mode: s.mode,
    target: s.target ?? null,
    temper: s.temper ?? null,
    minBank: minBank(s),
    round: s.round ?? null,
    rounds: ROUNDS,
    cur: s.cur,
    players: s.players.map(p => ({ total: p.total, bot: !!p.bot })),
    dice: s.dice,
    aside: s.aside,
    turnPts: s.turnPts,
    rollNo: s.rollNo,
    done: s.done,
    winner: s.winner,
  };
}

// The finished game for the player who started it: stake multiplier and a short description
export function result(s) {
  const me = s.players[0];
  if (s.mode === "bot") {
    const score = `${me.total} : ${s.players[1].total}`;
    return s.winner === 0
      ? { mult: BOT_WIN_MULT, label: `победа ${score}` }
      : { mult: 0, label: `поражение ${score}` };
  }
  const { mult } = SCORE_PAYOUT.find(r => me.total >= r.from);
  return { mult, label: `${me.total} очков, ×${mult}` };
}

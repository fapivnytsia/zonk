// ZONK. Offline the game runs right here; with a game link and a server address the server rolls the dice
// and the page only animates what it sends. Both ways a move gives a list of events (see engine/game.js),
// and the page plays them one by one.

import { scoreDice, scoringDice } from "./engine/rules.js";
import { newGame, act, publicState, SCORE_PAYOUT } from "./engine/game.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = ms => new Promise(r => setTimeout(r, RM ? Math.round(ms * 0.45) : ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const ROLL_MS = RM ? 240 : 950;
const NAMES = ["", "единица", "двойка", "тройка", "четвёрка", "пятёрка", "шестёрка"];
const SOLO_GOAL = SCORE_PAYOUT[0].from; // the bar on points fills up to the top payout
const fmt = n => n.toLocaleString("ru-RU");

// 1 монета, 2 монеты, 5 монет
function coins(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const word = a > 10 && a < 20 ? "монет" : b === 1 ? "монета" : b >= 2 && b <= 4 ? "монеты" : "монет";
  return `${fmt(n)} ${word}`;
}

const S = {
  mode: "bot", target: 5000, temper: "calm", minBank: 300, round: 1, rounds: 10,
  scores: [0, 0], cur: 0, turn: 0, rollNo: 0,
  tray: [], sel: new Set(), aside: [],
  busy: false, rolling: false, over: true, started: false,
  gen: 0, log: [], sound: true, tw: [false, false],
  seq: 0, foe: "Бот", // duel: the last event seen from the game's feed, the other player's name
};
const alive = g => g === S.gen;

// ---------- where the game runs ----------
// The mini app script is loaded only inside the messenger, a plain browser makes no outside requests at all.
// The server address comes from the page link (?api=host), never from this code.
let tg = null;
let engine = null;

async function loadTelegram() {
  if (!/tgWebAppData/.test(location.hash)) return null;
  await new Promise(done => {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = s.onerror = done;
    document.head.append(s);
  });
  return window.Telegram?.WebApp || null;
}

function serverEngine(host, token) {
  const call = async (route, body = {}) => {
    try {
      const res = await fetch(`https://${host}/zonk/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData: tg.initData, game: token, ...body }),
        referrerPolicy: "no-referrer",
      });
      return await res.json();
    } catch {
      return { error: "Нет связи с сервером игры. Попробуй ещё раз." };
    }
  };
  return {
    online: true,
    state: () => call("state"),
    start: opts => call("move", { action: "start", ...opts }),
    move: (action, picked) => call("move", { action, picked, rollNo: S.rollNo }),
  };
}

function localEngine() {
  let s = null;
  const reply = (events, error) => ({ events, state: publicState(s), ...(error && { error }) });
  return {
    online: false,
    async start(opts) {
      const ev = [];
      s = newGame({ mode: "bot", ...opts }, { id: 1, name: "Вы" }, ev);
      return reply(ev);
    },
    async move(action, picked) {
      const ev = [];
      const error = act(s, action, picked, ev);
      return error ? reply([], error) : reply(ev);
    },
  };
}

// ---------- prefs (this browser only) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("zonk.prefs") || "{}");
    if ([2000, 5000, 10000].includes(p.target)) S.target = p.target;
    if (["calm", "bold"].includes(p.temper)) S.temper = p.temper;
    if (typeof p.sound === "boolean") S.sound = p.sound;
  } catch (e) {}
}
function savePrefs() {
  try {
    localStorage.setItem("zonk.prefs", JSON.stringify({ target: S.target, temper: S.temper, sound: S.sound }));
  } catch (e) {}
}

const selVals = () => [...S.sel].sort((a, b) => a - b).map(i => S.tray[i]);

// ---------- audio ----------
// Soft sounds: everything goes through one quiet bus with a low-pass filter, only sine waves.
// Each throw within a turn sounds a little higher, so a long greedy turn audibly climbs.
const PITCH_STEP = 1.06; // about a semitone per throw
const PITCH_MAX = 1.6;
let ac = null, bus = null;
let rollPitch = 1; // grows with every throw of a turn, back to 1 when a turn starts
function audio() {
  if (!S.sound) return null;
  try {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200;
      bus = ac.createGain(); bus.gain.value = 0.7;
      bus.connect(lp).connect(ac.destination);
    }
    if (ac.state === "suspended") ac.resume();
    return ac;
  } catch (e) { return null; }
}
// A soft wooden knock: a short sine falling in pitch and a breath of muffled noise
function knock(t, pitch = 1, vol = 0.07) {
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + t;
  const f0 = rnd(240, 300) * pitch;
  const o = a.createOscillator(), g = a.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(f0 * 1.5, t0);
  o.frequency.exponentialRampToValueAtTime(f0, t0 + 0.04);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
  o.connect(g).connect(bus);
  o.start(t0); o.stop(t0 + 0.15);

  const len = Math.floor(a.sampleRate * 0.03);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900 * pitch;
  const ng = a.createGain(); ng.gain.value = vol * 0.6;
  src.connect(f).connect(ng).connect(bus);
  src.start(t0);
}
function tone(freq, t, dur, vol = 0.06) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = "sine"; o.frequency.value = freq;
  const t0 = a.currentTime + t;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(bus);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
// A throw: a few knocks spread over the animation at this turn's pitch, then the pitch goes up
function sndRoll(n) {
  for (let i = 0; i < 3 + n; i++) knock(rnd(0.02, ROLL_MS / 1000 * 0.8), rollPitch, rnd(0.04, 0.08));
  rollPitch = Math.min(PITCH_MAX, rollPitch * PITCH_STEP);
}
const sndPick = () => tone(rnd(600, 680), 0, 0.08, 0.03);
const sndTake = () => { tone(440, 0, 0.12, 0.04); tone(587, 0.06, 0.14, 0.035); };
const sndBank = () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.35, 0.05));
const sndZonk = () => { tone(330, 0, 0.35, 0.06); tone(247, 0.12, 0.45, 0.055); tone(196, 0.26, 0.6, 0.05); };
const sndHot = () => [523, 659, 784, 1047].forEach((f, i) => tone(f * Math.min(rollPitch, 1.3), i * 0.07, 0.25, 0.045));
const sndWin = () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 0.5, 0.05));
const sndLose = () => [392, 330, 262].forEach((f, i) => tone(f, i * 0.18, 0.5, 0.05));
const haptic = kind => {
  if (kind === "tap") tg?.HapticFeedback?.selectionChanged();
  else if (kind === "roll") tg?.HapticFeedback?.impactOccurred("medium");
  else tg?.HapticFeedback?.notificationOccurred(kind);
};

// ---------- dice rendering ----------
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const ROT = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
const cubeT = (v, a = 0, b = 0) => `rotateX(${ROT[v][0] + 360 * a}deg) rotateY(${ROT[v][1] + 360 * b}deg)`;
const pipsHTML = v => Array.from({ length: 9 }, (_, i) =>
  PIPS[v].includes(i) ? `<i class="p${v === 1 ? " r" : ""}"></i>` : "<i></i>").join("");
const mini = v => `<span class="mini" aria-label="${v}">${pipsHTML(v)}</span>`;
const CUBE_FACES = [1, 2, 3, 4, 5, 6].map(f => `<span class="face f${f}">${pipsHTML(f)}</span>`).join("");

const slotsHTML = () => Array.from({ length: 6 }, () => '<span class="slot"></span>').join("");

function buildDice(vals) {
  const box = $("#dice");
  box.innerHTML = "";
  vals.forEach((v, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "die";
    b.dataset.i = i;
    b.setAttribute("aria-label", `Кость ${i + 1}: ${NAMES[v]}`);
    b.style.setProperty("--jx", rnd(-7, 7).toFixed(1) + "%");
    b.style.setProperty("--jy", rnd(-6, 6).toFixed(1) + "%");
    b.style.setProperty("--jr", rnd(-16, 16).toFixed(1) + "deg");
    b.style.setProperty("--sx", rnd(-160, 160).toFixed(0) + "px");
    b.style.setProperty("--sy", rnd(140, 240).toFixed(0) + "px");
    b.style.setProperty("--dl", (i * 55) + "ms");
    b.innerHTML = `<span class="jit"><span class="shadow"></span><span class="ring"></span><span class="toss"><span class="cube">${CUBE_FACES}</span></span></span>`;
    box.append(b);
  });
  return $$("#dice .die");
}

function placeStatic(vals) {
  if (!vals.length) { $("#dice").innerHTML = slotsHTML(); return; }
  buildDice(vals).forEach((d, i) => {
    const c = d.querySelector(".cube");
    c.style.transition = "none";
    c.style.transform = cubeT(vals[i]);
  });
}

async function rollAnim(vals) {
  const dies = buildDice(vals);
  const box = $("#dice");
  dies.forEach(d => {
    const c = d.querySelector(".cube");
    c.style.transition = "none";
    c.style.transform = `rotateX(${rnd(0, 360)}deg) rotateY(${rnd(0, 360)}deg)`;
  });
  void box.offsetWidth;
  const spin = () => RM ? 0 : (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2));
  dies.forEach((d, i) => {
    d.classList.add("rolling");
    const c = d.querySelector(".cube");
    c.style.transition = "";
    c.style.transform = cubeT(vals[i], spin(), spin());
  });
  sndRoll(vals.length);
  await new Promise(r => setTimeout(r, ROLL_MS + vals.length * 55 + 40));
  dies.forEach(d => d.classList.remove("rolling"));
}

function renderAside() {
  $("#aside").innerHTML = S.aside.length
    ? S.aside.map(g => `<span class="grp">${g.vals.map(mini).join("")}<b>+${g.s}</b></span>`).join("")
    : '<span class="aside-empty">Отложенные кости хода</span>';
}

// ---------- ui ----------
function status(text, think = false) {
  $("#status").innerHTML = text + (think ? '<span class="dots"><i></i><i></i><i></i></span>' : "");
}

function flash(text, cls, ms = 1000) {
  const b = $("#banner");
  b.className = "banner";
  void b.offsetWidth;
  b.textContent = text;
  b.style.setProperty("--bt", ms + "ms");
  b.className = "banner show " + cls;
}

function popup(p, text, cls = "good") {
  const s = document.createElement("span");
  s.className = "pop " + cls;
  s.textContent = text;
  $("#p" + p).append(s);
  setTimeout(() => s.remove(), 1400);
}

function bumpTurn() {
  const v = $("#turn");
  v.classList.remove("bump"); void v.offsetWidth; v.classList.add("bump");
}

function tween(p, from, to) {
  const el = $("#t" + p);
  S.tw[p] = true;
  const t0 = performance.now(), D = RM ? 150 : 800;
  const step = t => {
    const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step); else { S.tw[p] = false; ui(); }
  };
  requestAnimationFrame(step);
}

const solo = () => S.mode === "score";
const duel = () => S.mode === "duel";
const foe = () => (duel() ? S.foe : "Бот");

function ui() {
  $("#players").classList.toggle("solo", solo());
  $("#foeName").textContent = foe();
  $("#p1").hidden = solo();
  for (const p of solo() ? [0] : [0, 1]) {
    if (!S.tw[p]) $("#t" + p).textContent = fmt(S.scores[p]);
    const goal = solo() || duel() ? SOLO_GOAL : S.target;
    $("#b" + p).style.width = Math.min(100, S.scores[p] / goal * 100) + "%";
    $("#m" + p).textContent = solo() || duel()
      ? `раунд ${Math.min(S.round, S.rounds)} из ${S.rounds}`
      : `осталось ${fmt(Math.max(0, S.target - S.scores[p]))}`;
    $("#p" + p).classList.toggle("on", S.started && !S.over && S.cur === p);
  }
  const sv = selVals();
  const ss = sv.length ? scoreDice(sv) || 0 : 0;
  $("#turn").textContent = fmt(S.turn);
  const sel = $("#selv");
  if (!sv.length) { sel.textContent = ""; sel.className = "selv"; }
  else if (ss > 0) { sel.textContent = "+" + ss; sel.className = "selv good"; }
  else { sel.textContent = "не даёт очков"; sel.className = "selv bad"; }

  const my = S.started && !S.over && S.cur === 0 && !S.busy;
  const fresh = S.tray.length === 0;
  const left = fresh ? 6 : (S.tray.length - S.sel.size) || 6;
  const roll = $("#roll");
  roll.disabled = !(my && (fresh || ss > 0));
  roll.classList.toggle("hot", my && !fresh && ss > 0 && S.tray.length === S.sel.size);
  $("#rollN").textContent = left;
  $("#bank").disabled = !(my && ss > 0 && S.turn + ss >= S.minBank);
  $("#bankV").textContent = fmt(S.turn + ss);
  $("#quitBtn").hidden = !(S.started && !S.over);
  $("#quitBtn").disabled = S.busy;
  refreshDice(ss);
}

function refreshDice(ss) {
  const live = !S.rolling && S.tray.length ? new Set(scoringDice(S.tray)) : null;
  $$("#dice .die").forEach(d => {
    const i = +d.dataset.i;
    const on = S.sel.has(i);
    d.classList.toggle("sel", on);
    d.classList.toggle("bad", on && ss <= 0);
    d.classList.toggle("dead", !!live && !on && !live.has(i));
    d.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderRules() {
  const items = duel()
    ? [
        "Бросьте кости и <strong>отложите хотя бы одну очковую</strong>.",
        "Дальше выбор: перебросить оставшиеся или <strong>записать</strong> очки хода.",
        "Бросок без очков — <strong>ZONK</strong>: очки хода сгорают, ход переходит.",
        "Все 6 костей дали очки — <strong>горячие кости</strong>: бросайте все 6 снова.",
        `${S.rounds} раундов, ходите по очереди. У кого больше очков — забирает банк, ничья — ставки назад.`,
      ]
    : solo()
    ? [
        "Бросьте кости и <strong>отложите хотя бы одну очковую</strong>.",
        "Дальше выбор: перебросить оставшиеся или <strong>записать</strong> очки хода.",
        "Бросок без очков — <strong>ZONK</strong>: очки хода сгорают.",
        "Все 6 костей дали очки — <strong>горячие кости</strong>: бросайте все 6 снова.",
        `${S.rounds} раундов, выплата — по сумме очков.`,
      ]
    : [
        "Бросьте кости и <strong>отложите хотя бы одну очковую</strong>.",
        "Дальше выбор: перебросить оставшиеся или <strong>записать</strong> очки хода.",
        `Записать можно, только набрав за ход <strong>не меньше ${S.minBank}</strong>.`,
        "Бросок без очков — <strong>ZONK</strong>: очки хода сгорают, ход переходит.",
        "Все 6 костей дали очки — <strong>горячие кости</strong>: бросайте все 6 снова.",
        "Побеждает тот, кто первым наберёт цель.",
      ];
  $("#rules").innerHTML = items.map(t => `<li>${t}</li>`).join("");
}

function setBrand(extra = "") {
  $("#brandSub").textContent = (duel() ? "дуэль" : solo() ? "на очки" : "против бота") + extra;
}

// ---------- log ----------
function addLog(who, html, cls = "") {
  S.log.unshift({ who, html, cls });
  S.log = S.log.slice(0, 40);
  renderLog();
}
function renderLog() {
  $("#log").innerHTML = S.log.length
    ? S.log.map(e => `<li class="${e.cls} w${e.who}"><span class="tag">${e.who === 0 ? "Вы" : e.who === 1 ? (duel() ? "Соп" : "Бот") : "—"}</span><span>${e.html}</span></li>`).join("")
    : '<li class="empty">Здесь появится история ходов.</li>';
}

// ---------- playing the events of a move ----------
async function replay(events, g) {
  for (const e of events) {
    if (!alive(g)) return;
    if (e.t === "turn") await showTurn(e);
    else if (e.t === "roll") await showRoll(e);
    else if (e.t === "pick") await showPick(e, g);
    else if (e.t === "take") await showTake(e);
    else if (e.t === "hot") await showHot(e);
    else if (e.t === "zonk") await showZonk(e);
    else if (e.t === "bank") await showBank(e);
  }
}

async function showTurn(e) {
  S.cur = e.p; S.turn = 0; S.tray = []; S.sel.clear(); S.aside = []; S.rolling = false;
  rollPitch = 1;
  if (e.round) S.round = e.round;
  $("#tray").classList.remove("zonked");
  renderAside();
  $("#dice").innerHTML = slotsHTML();
  ui();
  if (e.p === 0) {
    flash(solo() ? `Раунд ${S.round}` : "Ваш ход", "me", 1000);
    status("Ваш ход — бросайте кости");
    if (duel()) haptic("success");
  } else if (duel()) {
    flash("Ход соперника", "bot", 1000);
    status(`${foe()} ходит — ждём`, true);
    await sleep(600);
  } else {
    flash("Ход бота", "bot", 1000);
    status("Бот берёт кости", true);
    await sleep(900);
  }
}

async function showRoll(e) {
  S.rolling = true; S.sel.clear(); S.tray = e.dice;
  ui();
  status(e.p === 0 ? "Кости летят…" : `${foe()} бросает…`);
  if (e.p === 0) haptic("roll");
  await rollAnim(e.dice);
  S.rolling = false;
  ui();
  if (e.p === 0 && scoringDice(e.dice).length) status("Выберите очковые кости — нажмите на них");
}

async function showPick(e, g) {
  status("Бот думает", true);
  await sleep(700);
  for (const i of e.idx) {
    if (!alive(g)) return;
    S.sel.add(i); sndPick(); ui();
    await sleep(230);
  }
  status(e.bank ? `Бот останавливается на ${fmt(e.total)}` : `Бот берёт +${e.s} и рискует дальше`);
  await sleep(800);
}

async function showTake(e) {
  S.sel = new Set(e.idx);
  const vals = e.idx.map(i => S.tray[i]);
  e.idx.forEach(i => $(`#dice .die[data-i="${i}"]`)?.classList.add("take"));
  sndTake();
  await sleep(300);
  S.turn += e.s;
  S.aside.push({ vals: [...vals].sort((a, b) => a - b), s: e.s });
  S.tray = S.tray.filter((_, i) => !S.sel.has(i));
  S.sel.clear();
  $$("#dice .die.take").forEach(d => d.remove());
  $$("#dice .die").forEach((d, i) => { d.dataset.i = i; });
  renderAside(); bumpTurn(); ui();
  if (e.p === 1) await sleep(300);
}

async function showHot(e) {
  flash("Горячие кости!", "hot", 1200);
  sndHot();
  addLog(e.p, "горячие кости — все 6 снова");
  status("Все кости дали очки — бросок всеми шестью");
  await sleep(1100);
}

async function showZonk(e) {
  $("#tray").classList.add("zonked");
  sndZonk();
  if (e.p === 0) haptic("error");
  if (e.lost > 0) popup(e.p, "−" + fmt(e.lost), "bad");
  addLog(e.p, e.lost > 0 ? `ZONK, сгорело ${fmt(e.lost)}` : "ZONK", "zonk");
  status(e.p === 0 ? "Ни одной очковой кости" : duel() ? "У соперника пусто" : "У бота пусто");
  S.turn = 0;
  ui();
  await sleep(1700);
  $("#tray").classList.remove("zonked");
}

async function showBank(e) {
  const from = S.scores[e.p];
  S.scores[e.p] = e.total;
  popup(e.p, "+" + fmt(e.gain));
  sndBank();
  if (e.p === 0) haptic("success");
  tween(e.p, from, e.total);
  addLog(e.p, `${e.p ? "записал" : "записали"} <em>+${fmt(e.gain)}</em> → ${fmt(e.total)}`);
  status(e.p ? `${foe()} записал ${fmt(e.gain)}` : `Записано ${fmt(e.gain)}`);
  S.turn = 0;
  ui();
  await sleep(1000);
}

// Takes the board as the engine sees it. redraw: put the dice down without animation (reload, missed move).
function sync(st, redraw) {
  Object.assign(S, {
    mode: st.mode, minBank: st.minBank, rounds: st.rounds, cur: st.cur, turn: st.turnPts, rollNo: st.rollNo,
    target: st.target ?? S.target, temper: st.temper ?? S.temper, round: st.round ?? S.round,
    seq: st.seq ?? S.seq,
  });
  S.scores = [st.players[0].total, st.players[1]?.total ?? 0];
  const same = S.tray.length === st.dice.length && S.tray.every((v, i) => v === st.dice[i]);
  if (redraw || !same) {
    S.tray = [...st.dice];
    S.sel.clear();
    placeStatic(S.tray);
  }
  S.aside = st.aside.map(a => ({ vals: a.vals, s: a.s }));
  renderAside();
  renderRules();
}

// What the engine answered to a start or a move
async function apply(r, g) {
  if (r.gone) return showGone();
  if (r.foe) S.foe = r.foe;
  if (r.events) await replay(r.events, g);
  if (!alive(g)) return;
  // No events and no error: the page missed a move, the dice are put down as they are now
  if (r.state) sync(r.state, !r.events && !r.error);
  if (r.error) status(r.error);
  S.busy = false;
  ui();
  if (r.state?.done || r.final) return finish(r);
  watch();
}

// ---------- duel: watching the other player ----------
// While it is the other player's turn the page asks the server every POLL_MS and plays their moves
// from the game's feed: the events it has not seen yet.
const POLL_MS = 2500;
let watching = false;

function watch() {
  if (watching || !engine?.online || !duel() || S.over || S.cur === 0) return;
  watching = true;
  setTimeout(lookAgain, POLL_MS);
}

async function lookAgain() {
  watching = false;
  if (!duel() || S.over || S.cur === 0) return;
  if (S.busy) return watch();
  const g = S.gen;
  const r = await engine.state();
  if (!alive(g) || S.over) return;
  if (r.gone) return showGone();
  if (r.error) return watch();
  if (r.foe) S.foe = r.foe;
  const fresh = (r.state?.feed || []).filter(e => e.n > S.seq);
  if (fresh.length) {
    S.busy = true;
    ui();
    await replay(fresh, g);
    if (!alive(g)) return;
  }
  if (r.state) sync(r.state, false);
  S.busy = false;
  ui();
  if (r.state?.done || r.final) return finish(r);
  watch();
}

// ---------- player input ----------
const canMove = () => S.started && !S.over && S.cur === 0 && !S.busy;

// "Закончить сессию": the game is lost at once, after a confirmation
async function onQuit() {
  if (!S.started || S.over || S.busy) return;
  const q = "Закончить партию? Это засчитается как проигрыш.";
  const sure = tg?.showConfirm ? await new Promise(ok => tg.showConfirm(q, ok)) : window.confirm(q);
  if (!sure || S.over || S.busy) return;
  const g = S.gen;
  S.busy = true;
  ui();
  const r = await engine.move("forfeit", []);
  if (!alive(g)) return;
  await apply(r, g);
}

async function move(action) {
  const g = S.gen;
  const picked = [...S.sel].sort((a, b) => a - b);
  S.busy = true;
  ui();
  if (action === "roll") status("Кости летят…", true);
  const r = await engine.move(action, picked);
  if (!alive(g)) return;
  await apply(r, g);
}

function onRoll() {
  if (!canMove()) return;
  if (S.tray.length && !(scoreDice(selVals()) > 0)) return;
  move("roll");
}

function onBank() {
  if (!canMove()) return;
  const ss = scoreDice(selVals()) || 0;
  if (ss <= 0 || S.turn + ss < S.minBank) return;
  move("bank");
}

function toggleDie(i) {
  if (!canMove() || i >= S.tray.length) return;
  if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i);
  sndPick();
  haptic("tap");
  ui();
  const ss = scoreDice(selVals()) || 0;
  if (!S.sel.size) status("Выберите очковые кости — нажмите на них");
  else if (ss > 0 && S.turn + ss < S.minBank) status(`Выбрано +${ss}. Записать можно от ${S.minBank} — бросайте дальше`);
  else if (ss > 0) status(`Выбрано +${ss}. Бросайте дальше или записывайте`);
  else status("Эти кости не дают очков вместе");
}

// ---------- modal cards ----------
function showCard(id) {
  for (const c of ["#startView", "#onlineView", "#endView", "#msgView"]) $(c).hidden = c !== id;
  $("#modal").hidden = false;
}
const hideModal = () => { $("#modal").hidden = true; };

function closeApp() {
  if (tg) tg.close();
  else hideModal();
}

function showMessage(title, text) {
  S.over = true;
  tg?.disableClosingConfirmation?.();
  $("#msgTitle").textContent = title;
  $("#msgText").textContent = text;
  showCard("#msgView");
}

const showGone = () => showMessage("Партия закончилась", "Новую партию начни там, откуда открыл игру.");

// ---------- start: in a plain browser ----------
function syncForm() {
  $(`input[name="target"][value="${S.target}"]`).checked = true;
  $(`input[name="temper"][value="${S.temper}"]`).checked = true;
}

function openStart() {
  syncForm();
  const inGame = S.started && !S.over;
  $("#cancelBtn").hidden = !inGame;
  $("#startBtns").classList.toggle("two", inGame);
  $("#startBtn").textContent = inGame ? "Начать заново" : "Начать партию";
  showCard("#startView");
  setTimeout(() => $("#startBtn").focus(), 50);
}

function resetBoard() {
  S.gen++;
  S.scores = [0, 0]; S.tw = [false, false];
  S.over = false; S.started = true; S.busy = true;
  S.log = [];
  renderLog();
  renderRules();
  setBrand();
  ui();
}

async function startLocal() {
  S.target = +$('input[name="target"]:checked').value;
  S.temper = $('input[name="temper"]:checked').value;
  S.mode = "bot";
  savePrefs();
  audio();
  resetBoard();
  hideModal();
  addLog(2, `партия до ${fmt(S.target)}, бот ${S.temper === "bold" ? "азартный" : "осторожный"}`);
  const r = await engine.start({ target: S.target, temper: S.temper });
  addLog(2, `жребий: первым ходит ${r.events[0].p ? "бот" : "игрок"}`);
  await apply(r, S.gen);
}

// ---------- start: online ----------
function openOnlineStart(bet, picking) {
  $("#betLine").textContent = `Ставка: ${coins(bet)}. Списывается при старте.`;
  $("#botWinNote").textContent = `победа ×${picking.botWin}`;
  $("#roundsNote").textContent = `${picking.rounds} раундов`;
  $("#targetSeg").innerHTML = picking.targets.map((t, i) =>
    `<input type="radio" name="btarget" id="bt${i}" value="${t}"${t === S.target ? " checked" : ""}><label for="bt${i}">${fmt(t)}</label>`).join("");
  $("#temperSeg").innerHTML = Object.entries(picking.tempers).map(([k, v]) =>
    `<input type="radio" name="btemper" id="bm${k}" value="${k}"${k === S.temper ? " checked" : ""}><label for="bm${k}">${v[0].toUpperCase() + v.slice(1)}</label>`).join("");
  $("#paytable").innerHTML = picking.payout.slice().reverse().map(r => `<li>${fmt(r.from)}+ <b>×${r.mult}</b></li>`).join("");
  $("#mdBot").checked = true;
  S.minBank = picking.minBank;
  modeFields();
  $("#onlineErr").textContent = "";
  showCard("#onlineView");
}

function modeFields() {
  const score = $("#mdScore").checked;
  $("#botFields").hidden = score;
  $("#scoreFields").hidden = !score;
}

async function startOnline() {
  const mode = $("#mdScore").checked ? "score" : "bot";
  const target = +($('input[name="btarget"]:checked')?.value || 5000);
  const temper = $('input[name="btemper"]:checked')?.value || "calm";
  $("#onlineStartBtn").disabled = true;
  audio();
  const r = await engine.start({ mode, target, temper });
  $("#onlineStartBtn").disabled = false;
  if (r.gone) return showGone();
  if (r.error || !r.events) {
    $("#onlineErr").textContent = r.error || "Не получилось начать.";
    return;
  }
  S.mode = mode; S.target = target; S.temper = temper;
  savePrefs();
  resetBoard();
  setBrand(` · ставка ${fmt(r.bet)}`);
  hideModal();
  tg?.enableClosingConfirmation?.();
  addLog(2, mode === "score"
    ? `на очки, ${r.state.rounds} раундов, ставка ${coins(r.bet)}`
    : `партия до ${fmt(target)}, бот ${temper === "bold" ? "азартный" : "осторожный"}, ставка ${coins(r.bet)}`);
  if (mode === "bot") addLog(2, `жребий: первым ходит ${r.events[0].p ? "бот" : "игрок"}`);
  await apply(r, S.gen);
}

// ---------- end ----------
function finish(r) {
  const st = r.state || {};
  S.over = true; S.busy = false;
  tg?.disableClosingConfirmation?.();
  ui();
  const net = r.result?.net;
  const iGaveUp = st.forfeited && st.forfeitedBy === 0;
  const foeGaveUp = st.forfeited && st.forfeitedBy === 1;
  const draw = duel() && !st.forfeited && (net === 0 || (net === undefined && st.done && st.winner === null));
  const won = duel() ? (net !== undefined ? net > 0 : foeGaveUp || st.winner === 0)
    : !st.forfeited && (solo() ? (net ?? 0) > 0 : st.winner === 0);
  const gaveUp = st.abandoned ? "Партия брошена" : "Партия сдана";
  const foeGone = st.abandoned ? "Соперник бросил партию" : "Соперник сдался";
  const title = iGaveUp ? gaveUp : foeGaveUp ? foeGone : solo() ? "Итог" : draw ? "Ничья" : won ? "Победа!" : `${foe()} выиграл`;

  if (iGaveUp) addLog(0, st.abandoned ? "бросили партию" : "сдались", "zonk");
  else if (foeGaveUp) addLog(1, st.abandoned ? "бросил партию" : "сдался", "zonk");
  else if (draw) addLog(2, "ничья");
  else if (!solo()) addLog(won ? 0 : 1, won ? "выиграли партию!" : "выигрывает партию", "win");
  status(solo() && !iGaveUp ? `Итог: ${fmt(S.scores[0])} очков` : title);
  if (won) { sndWin(); confetti(); } else if (!draw) sndLose();

  $("#endTitle").textContent = title;
  $("#fs0").textContent = fmt(S.scores[0]);
  $("#fs1").textContent = fmt(S.scores[1]);
  $("#fsSep").hidden = $("#fs1").hidden = solo();
  $("#fs0").classList.toggle("w", won);
  $("#fs1").classList.toggle("w", !solo() && !won && !draw);

  const money = engine.online && r.result;
  $("#money").hidden = !money;
  if (money) {
    const net = r.result.net;
    $("#moneyNet").textContent = net > 0 ? `+${coins(net)}` : net < 0 ? `−${coins(-net)}` : "Ставка вернулась";
    $("#moneyNet").classList.toggle("bad", net < 0);
    $("#moneyBal").textContent = `баланс ${coins(r.result.balance)}`;
  }
  $("#endText").textContent = engine.online
    ? "Новую партию начни там, откуда открыл игру."
    : st.forfeited
      ? "Бот засчитал победу. Начните новую партию."
      : won
      ? `Вы первым добрались до ${fmt(S.target)}. Бот требует реванша.`
      : `Бот первым набрал ${fmt(S.target)}. Попробуйте ещё раз.`;
  $("#endBtns").hidden = engine.online;
  $("#closeBtns").hidden = !engine.online;

  setTimeout(() => {
    if (!S.over) return;
    showCard("#endView");
    (engine.online ? $("#closeBtn") : $("#againBtn")).focus();
  }, RM ? 300 : 1300);
}

// ---------- confetti ----------
function confetti() {
  if (RM) return;
  const c = $("#fx"), ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ivory = css("--ivory"), pip = css("--pip"), red = css("--pip-red"), brass = css("--brass");
  const P = Array.from({ length: 150 }, () => ({
    x: W / 2 + rnd(-80, 80), y: H * 0.42, vx: rnd(-8, 8), vy: rnd(-15, -5),
    s: rnd(7, 13), r: rnd(0, 6), vr: rnd(-0.25, 0.25),
    kind: Math.random() < 0.6 ? "die" : "chip", red: Math.random() < 0.2,
  }));
  const t0 = performance.now();
  const step = t => {
    ctx.clearRect(0, 0, W, H);
    P.forEach(p => {
      p.vy += 0.34; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      if (p.kind === "die") {
        ctx.fillStyle = ivory; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
        ctx.fillStyle = p.red ? red : pip;
        ctx.beginPath(); ctx.arc(0, 0, p.s * 0.16, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = brass; ctx.fillRect(-p.s / 2, -p.s / 5, p.s, p.s / 2.5);
      }
      ctx.restore();
    });
    if (t - t0 < 3400) requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(step);
}

// ---------- static content ----------
function buildCombos() {
  const C = [
    [[1], "100"],
    [[5], "50"],
    [[1, 1, 1], "1000"],
    [[4, 4, 4], "400", "Три одинаковых: номинал × 100"],
    [[6, 6, 6, 6], "1200", "Четыре — тройка × 2"],
    [[5, 5, 5, 5, 5], "2000", "Пять — × 4, шесть — × 8"],
    [[3, 3, 3, 2, 2], "1000", "Фулл-хаус: три одинаковых и пара"],
    [[1, 2, 3, 4, 5], "500", "Малый стрит без шестёрки"],
    [[2, 3, 4, 5, 6], "750", "Малый стрит без единицы"],
    [[1, 2, 3, 4, 5, 6], "1500", "Большой стрит"],
    [[2, 2, 3, 3, 6, 6], "750", "Три пары"],
  ];
  $("#combos").innerHTML = C.map(([v, s, note]) =>
    `<li><span class="dd">${v.map(mini).join("")}</span><b>${s}</b>${note ? `<small>${note}</small>` : ""}</li>`).join("");
  $("#demo").innerHTML = $("#demo2").innerHTML = [1, 5, 5, 3, 1, 6].map(mini).join("");
}

function setSoundBtn() {
  $("#sndBtn").setAttribute("aria-pressed", S.sound ? "true" : "false");
  $("#sndTxt").textContent = S.sound ? "Звук" : "Без звука";
}

// ---------- wiring ----------
function wire() {
  $("#roll").addEventListener("click", onRoll);
  $("#bank").addEventListener("click", onBank);
  $("#dice").addEventListener("click", e => {
    const d = e.target.closest(".die");
    if (d) toggleDie(+d.dataset.i);
  });
  $("#startBtn").addEventListener("click", startLocal);
  $("#cancelBtn").addEventListener("click", hideModal);
  $("#againBtn").addEventListener("click", () => { syncForm(); startLocal(); });
  $("#setBtn").addEventListener("click", openStart);
  $("#newBtn").addEventListener("click", openStart);
  $("#onlineStartBtn").addEventListener("click", startOnline);
  $("#mdBot").addEventListener("change", modeFields);
  $("#mdScore").addEventListener("change", modeFields);
  $("#closeBtn").addEventListener("click", closeApp);
  $("#quitBtn").addEventListener("click", onQuit);
  $("#msgBtn").addEventListener("click", closeApp);
  $("#sndBtn").addEventListener("click", () => {
    S.sound = !S.sound; setSoundBtn(); savePrefs();
    if (S.sound) sndPick();
  });

  document.addEventListener("keydown", e => {
    if (!$("#modal").hidden) {
      if (e.key === "Escape" && !$("#cancelBtn").hidden && !$("#startView").hidden) hideModal();
      return;
    }
    if (e.target.closest && e.target.closest("input")) return;
    if (e.code === "Space") { e.preventDefault(); onRoll(); }
    else if (e.key === "Enter") {
      if (e.target.closest && e.target.closest("button") && !e.target.closest(".die")) return;
      e.preventDefault(); onBank();
    }
    else if (/^[1-6]$/.test(e.key)) toggleDie(+e.key - 1);
  });
}

async function bootOnline() {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.setHeaderColor?.("#150d0f");
  tg.setBackgroundColor?.("#150d0f");
  $("#newBtn").hidden = true;
  status("Загрузка", true);

  const r = await engine.state();
  if (r.error) return showMessage("Не получилось", r.error);
  if (r.gone) return showGone();
  if (r.picking) return openOnlineStart(r.bet, r.picking);

  // Back into a game that is already on, or a duel that ended while the page was closed
  S.started = true; S.over = false; S.busy = false; S.gen++;
  if (r.foe) S.foe = r.foe;
  if (r.state) sync(r.state, true);
  setBrand(` · ставка ${fmt(r.bet)}`);
  hideModal();
  if (r.final || r.state?.done) return finish(r);
  tg.enableClosingConfirmation?.();
  addLog(2, duel() ? `дуэль с ${S.foe}` : "партия продолжается");
  status(
    S.cur !== 0 ? `${foe()} ходит — ждём`
    : S.tray.length ? "Выберите очковые кости — нажмите на них" : "Ваш ход — бросайте кости",
    S.cur !== 0
  );
  ui();
  watch();
}

async function boot() {
  loadPrefs();
  buildCombos();
  wire();
  setSoundBtn();
  renderAside();
  renderLog();
  renderRules();

  tg = await loadTelegram();
  const host = new URLSearchParams(location.search).get("api") || "";
  const token = tg?.initDataUnsafe?.start_param || "";
  if (tg?.initData && token && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
    engine = serverEngine(host, token);
    return bootOnline();
  }

  // No game link or no server address: the game runs here
  tg?.ready();
  tg?.expand();
  engine = localEngine();
  placeStatic([1, 5, 5, 3, 1, 6]);
  status("Настройте партию и начинайте");
  ui();
  openStart();
}

boot();

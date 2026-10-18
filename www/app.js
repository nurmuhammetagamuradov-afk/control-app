/* Контроль — личное приложение тотального контроля дня.
   Все данные хранятся только на телефоне (localStorage). */
'use strict';

const KEY = 'kontrol_v1';
const DAY_SHIFT_MIN = 4 * 60; // день заканчивается в 04:00, чтобы поздний отбой считался тем же днём
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

const Cap = window.Capacitor;
const LN = Cap && Cap.Plugins ? Cap.Plugins.LocalNotifications : null;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const platform = Cap && Cap.getPlatform ? Cap.getPlatform() : 'web';

/* ---------- хранение ---------- */
const DEFAULTS = {
  setupDone: false,
  name: '',
  wake: '08:00',
  bed: '00:30',
  workStart: '10:00',
  workEnd: '22:00',
  checkEvery: 3,   // часов между отчётами
  nagMin: 10,      // через сколько минут дожимать
  goals: [],
  habits: []
};

let S = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { settings: Object.assign({}, DEFAULTS, d.settings || {}), days: d.days || {} };
    }
  } catch (e) {}
  return { settings: Object.assign({}, DEFAULTS), days: {} };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Не удалось сохранить данные'); }
  scheduleSoon();
}

/* ---------- время ---------- */
const pad = n => String(n).padStart(2, '0');
const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const uid = () => Math.random().toString(36).slice(2, 9);
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dayKey(date) { return ymd(new Date((date || new Date()).getTime() - DAY_SHIFT_MIN * 60000)); }
function dayStart(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); }
function shiftKey(key, n) { const d = dayStart(key); d.setDate(d.getDate() + n); return ymd(d); }
// минуты от полуночи дня; время до 04:00 относится к следующей календарной ночи
function absMin(hhmm) { const m = toMin(hhmm); return m < DAY_SHIFT_MIN ? m + 1440 : m; }
function at(key, minutes) { const d = dayStart(key); d.setMinutes(minutes); return d; }

function times(key) {
  const st = S.settings;
  const wake = absMin(st.wake);
  const bed = Math.max(absMin(st.bed), wake + 8 * 60);
  const report = bed - 90;
  const every = Math.max(1, Number(st.checkEvery) || 3) * 60;
  const slots = [];
  for (let t = wake + every; t <= report - 45; t += every) slots.push(t);
  return {
    wake: at(key, wake), bed: at(key, bed), report: at(key, report),
    reportOpen: at(key, report - 150),
    slots: slots.map(m => at(key, m))
  };
}

function prettyDate(key) {
  const d = dayStart(key);
  return WD[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
}

/* ---------- данные дня ---------- */
function getDay(key, create = true) {
  if (!S.days[key] && create) S.days[key] = { tasks: [], planAt: null, checkins: {}, habits: {}, report: null };
  return S.days[key];
}
function goalName(id) { const g = S.settings.goals.find(g => g.id === id); return g ? g.name : 'Без цели'; }

function dayScore(key) {
  const d = S.days[key];
  if (!d) return 0;
  const T = times(key);
  let s = 0;
  if (d.tasks.length) {
    const v = d.tasks.reduce((a, t) => a + (t.status === 'done' ? 1 : t.status === 'prog' ? 0.3 : 0), 0) / d.tasks.length;
    s += v * 60;
  }
  const hs = S.settings.habits;
  if (hs.length) s += hs.filter(h => d.habits[h.id]).length / hs.length * 20; else s += d.tasks.length ? 20 * (d.planAt ? 1 : 0) : 0;
  if (T.slots.length) s += T.slots.filter((_, i) => d.checkins[i]).length / T.slots.length * 10; else s += 10;
  if (d.report) s += 10;
  return Math.round(s);
}

function habitStreak(hid, todayKey) {
  let n = 0, k = todayKey;
  if (!(S.days[k] && S.days[k].habits[hid])) k = shiftKey(k, -1);
  while (S.days[k] && S.days[k].habits[hid]) { n++; k = shiftKey(k, -1); }
  return n;
}
function disciplineStreak(todayKey) {
  let n = 0, k = todayKey;
  const full = x => S.days[x] && S.days[x].planAt && S.days[x].report;
  if (!full(k)) k = shiftKey(k, -1);
  while (full(k)) { n++; k = shiftKey(k, -1); }
  return n;
}

/* ---------- строгие фразы ---------- */
const pick = a => a[Math.floor(Math.random() * a.length)];
const TXT = {
  plan: [
    'Без плана день уходит впустую. Запиши 3 задачи — сейчас.',
    'Ты уже встал, а плана нет. Это не дисциплина.',
    'Цели сами себя не достигнут. Открывай и пиши план.',
    'Каждая минута без плана — минута в пустоту.'
  ],
  checkin: [
    'Что ты сделал за последние часы? Отчитайся.',
    'Время отчёта. Конкретно: что продвинул?',
    'Проверка. Ты двигаешься к цели или отвлекаешься?'
  ],
  nag: [
    'Ты игнорируешь отчёт. Это уже провал.',
    'Я жду. Отговорки не принимаются.',
    'Молчание — это тоже ответ. Плохой.',
    'Сильные люди отчитываются вовремя. Открывай.'
  ],
  report: [
    'Время вечернего отчёта. Честно: что сделано, что нет?',
    'День заканчивается. Сдай отчёт.',
    'Без отчёта день не засчитан.'
  ]
};

/* ---------- уведомления ---------- */
let schedTimer = null;
function scheduleSoon() { clearTimeout(schedTimer); schedTimer = setTimeout(rescheduleAll, 600); }

async function notifPermission(ask) {
  if (!LN) return 'none';
  try {
    let p = await LN.checkPermissions();
    if (p.display !== 'granted' && ask) p = await LN.requestPermissions();
    return p.display;
  } catch (e) { return 'error'; }
}

async function setupChannel() {
  if (!LN || platform !== 'android') return;
  try {
    await LN.createChannel({ id: 'kontrol', name: 'Контроль', description: 'Напоминания и проверки', importance: 5, visibility: 1, vibration: true, lights: true });
  } catch (e) {}
}

function buildPlan() {
  const st = S.settings, now = Date.now(), out = [];
  const nag = Math.max(5, Number(st.nagMin) || 10) * 60000;
  const add = (date, title, body, screen) => { if (date.getTime() > now + 15000) out.push({ at: date, title, body, screen }); };
  const today = dayKey();
  for (const key of [today, shiftKey(today, 1)]) {
    const d = S.days[key] || { tasks: [], planAt: null, checkins: {}, report: null, habits: {} };
    const T = times(key);
    // утро: план дня
    if (!d.planAt) {
      add(T.wake, 'Подъём. План дня', pick(TXT.plan), 'today');
      for (let i = 1; i <= 6; i++) add(new Date(T.wake.getTime() + i * nag), 'План дня не составлен', pick(TXT.plan), 'today');
    }
    // проверки в течение дня
    T.slots.forEach((t, i) => {
      if (d.checkins[i]) return;
      add(t, 'Отчёт ' + hm(t), pick(TXT.checkin), 'today');
      add(new Date(t.getTime() + nag), 'Отчёт ' + hm(t) + ' не сдан', pick(TXT.nag), 'today');
      add(new Date(t.getTime() + 2 * nag), 'Последнее предупреждение', 'Отчёт ' + hm(t) + ' будет засчитан как провал.', 'today');
    });
    // привычки
    if (st.habits.length) add(new Date(T.report.getTime() - 120 * 60000), 'Привычки', 'Проверь привычки. Не отмеченное до отбоя — провал.', 'today');
    // вечерний отчёт
    if (!d.report) {
      add(T.report, 'Вечерний отчёт', pick(TXT.report), 'today');
      for (let t = T.report.getTime() + nag; t < T.bed.getTime(); t += nag) add(new Date(t), 'Отчёт не сдан', pick(TXT.nag), 'today');
    }
    add(new Date(T.bed.getTime() - 30 * 60000), 'Через 30 минут отбой', 'Закругляйся. Завтра рано вставать.', 'today');
    add(T.bed, 'Отбой ' + st.bed, d.report ? 'Телефон в сторону. Спать.' : 'Отчёт так и не сдан. День провален. Телефон в сторону.', 'today');
    // воскресенье — итоги недели
    if (dayStart(key).getDay() === 0) add(new Date(T.report.getTime() - 60 * 60000), 'Итоги недели', 'Неделя закончилась. Посмотри, где ты просел.', 'stats');
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, 60);
}

async function rescheduleAll() {
  if (!LN || !S.settings.setupDone) return;
  try {
    const p = await LN.getPending();
    if (p.notifications && p.notifications.length) await LN.cancel({ notifications: p.notifications.map(n => ({ id: n.id })) });
    const plan = buildPlan();
    if (!plan.length) return;
    await LN.schedule({
      notifications: plan.map((n, i) => ({
        id: 1000 + i,
        title: n.title,
        body: n.body,
        largeBody: n.body,
        channelId: 'kontrol',
        schedule: { at: n.at, allowWhileIdle: true },
        extra: { screen: n.screen }
      }))
    });
  } catch (e) { console.warn('schedule failed', e); }
}

/* ---------- интерфейс ---------- */
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let tab = 'today';
let wiz = { step: 0, d: null };
let draft = {}; // временные поля форм

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function render() {
  if (!S.settings.setupDone) { $nav.hidden = true; $app.innerHTML = renderWizard(); return; }
  $nav.hidden = false;
  $nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $app.innerHTML = tab === 'today' ? renderToday() : tab === 'stats' ? renderStats() : renderSettings();
  if (tab === 'settings') fillExactStatus();
}

/* ----- мастер первого запуска ----- */
const HABIT_PRESETS = ['Спорт / зарядка', 'Вода 2 литра', 'Чтение 20 минут', 'Без соцсетей до обеда', 'Английский 15 минут', 'Без сладкого', 'Прогулка'];
function renderWizard() {
  if (!wiz.d) wiz.d = JSON.parse(JSON.stringify(S.settings));
  const d = wiz.d, N = 5;
  const steps = '<div class="steps">' + Array.from({ length: N }, (_, i) => `<i class="${i <= wiz.step ? 'on' : ''}"></i>`).join('') + '</div>';
  let body = '';
  if (wiz.step === 0) body = `
    <h1>Контроль</h1>
    <p class="muted">Это приложение будет держать тебя в рамках весь день: план утром, отчёты днём, честный итог вечером. Пропустишь — будет дожимать.</p>
    <div class="card">
      <label>Как к тебе обращаться?</label>
      <input data-w="name" value="${esc(d.name)}" placeholder="Имя" autocomplete="off">
    </div>
    <button class="btn" data-act="wnext">Начать</button>`;
  if (wiz.step === 1) body = `
    <h1>Режим дня</h1>
    <p class="muted">В это время приложение будет требовать план и отправлять спать.</p>
    <div class="card">
      <div class="row"><div class="grow"><label>Подъём</label><input type="time" data-w="wake" value="${esc(d.wake)}"></div>
      <div class="grow"><label>Отбой</label><input type="time" data-w="bed" value="${esc(d.bed)}"></div></div>
      <div class="row"><div class="grow"><label>Работа с</label><input type="time" data-w="workStart" value="${esc(d.workStart)}"></div>
      <div class="grow"><label>Работа до</label><input type="time" data-w="workEnd" value="${esc(d.workEnd)}"></div></div>
    </div>
    <button class="btn" data-act="wnext">Дальше</button><button class="btn ghost" data-act="wback">Назад</button>`;
  if (wiz.step === 2) body = `
    <h1>Большие цели</h1>
    <p class="muted">К чему ты идёшь в ближайшие месяцы. Каждая задача дня будет привязана к одной из целей. Минимум одна, максимум пять.</p>
    <div class="card list-edit">
      ${d.goals.map((g, i) => `<div class="row"><input data-goal="${i}" value="${esc(g.name)}" placeholder="Например: развить Owaz"><button class="x" data-act="wdelgoal" data-i="${i}">✕</button></div>`).join('')}
      ${d.goals.length < 5 ? '<button class="btn ghost" data-act="waddgoal">+ Добавить цель</button>' : ''}
    </div>
    <button class="btn" data-act="wnext">Дальше</button><button class="btn ghost" data-act="wback">Назад</button>`;
  if (wiz.step === 3) body = `
    <h1>Привычки</h1>
    <p class="muted">Что ты обязан делать каждый день. Нажми, чтобы выбрать, или добавь своё.</p>
    <div class="card">
      <div class="chips">${HABIT_PRESETS.map(h => `<button class="chip ${d.habits.some(x => x.name === h) ? 'on' : ''}" data-act="wchip" data-h="${esc(h)}">${esc(h)}</button>`).join('')}
      ${d.habits.filter(x => !HABIT_PRESETS.includes(x.name)).map(x => `<button class="chip on" data-act="wchip" data-h="${esc(x.name)}">${esc(x.name)}</button>`).join('')}</div>
      <div class="row" style="margin-top:12px"><input id="newhabit" placeholder="Своя привычка"><button class="btn sm ghost" data-act="waddhabit">Добавить</button></div>
    </div>
    <button class="btn" data-act="wnext">Дальше</button><button class="btn ghost" data-act="wback">Назад</button>`;
  if (wiz.step === 4) body = `
    <h1>Жёсткость</h1>
    <div class="card">
      <label>Отчёт о прогрессе каждые</label>
      <div class="seg">${[2, 3, 4].map(h => `<button class="${d.checkEvery == h ? 'on' : ''}" data-act="wset" data-k="checkEvery" data-v="${h}">${h} часа</button>`).join('')}</div>
      <label>Если не ответил — повторять через</label>
      <div class="seg">${[5, 10, 15].map(m => `<button class="${d.nagMin == m ? 'on' : ''}" data-act="wset" data-k="nagMin" data-v="${m}">${m} мин</button>`).join('')}</div>
    </div>
    <div class="card warn"><p class="verdict">Разреши уведомления</p><p class="muted small">Без них контроль не работает. На следующем шаге телефон спросит разрешение — нажми «Разрешить».</p></div>
    <button class="btn" data-act="wfinish">Включить контроль</button><button class="btn ghost" data-act="wback">Назад</button>`;
  return steps + body;
}

function wizCollect() {
  const d = wiz.d;
  $app.querySelectorAll('[data-w]').forEach(el => { d[el.dataset.w] = el.value; });
  $app.querySelectorAll('[data-goal]').forEach(el => { d.goals[+el.dataset.goal].name = el.value.trim(); });
}

/* ----- экран «Сегодня» ----- */
function renderToday() {
  const key = dayKey(), d = getDay(key), T = times(key), now = new Date(), st = S.settings;
  const score = dayScore(key);
  let html = `<div class="row between"><div><div class="muted small">${prettyDate(key)}</div><h1>${st.name ? esc(st.name) + ', ' : ''}${greet(now)}</h1></div>
    <div style="text-align:right"><div class="score" style="color:${score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)'}">${score}</div><div class="muted small">очков дня</div></div></div>`;
  html += `<div class="bar ${score >= 70 ? 'g' : score >= 40 ? 'a' : ''}" style="margin-bottom:16px"><i style="width:${score}%"></i></div>`;

  // 1. План дня
  if (!d.planAt) {
    const late = now >= T.wake;
    const pre = draft.plan || defaultPlanDraft(key);
    draft.plan = pre;
    html += `<div class="card ${late ? 'alert' : ''}">
      <div class="row between"><h2>План дня</h2>${late ? '<span class="tag red">НЕ СОСТАВЛЕН</span>' : ''}</div>
      <p class="muted small">3 главные задачи, каждая двигает тебя к цели. Конкретно и измеримо: не «работать», а «нанять бариста на вечер».</p>
      ${pre.map((t, i) => `<label>Задача ${i + 1}</label>
        <input data-plan="${i}" value="${esc(t.text)}" placeholder="${['Самое важное на сегодня', 'Вторая задача', 'Третья задача'][i]}">
        <select data-plangoal="${i}" style="margin-top:6px">${st.goals.map(g => `<option value="${g.id}" ${g.id === t.goalId ? 'selected' : ''}>→ ${esc(g.name)}</option>`).join('')}</select>`).join('')}
      <button class="btn" data-act="saveplan">Зафиксировать план</button>
    </div>`;
  } else {
    const doneN = d.tasks.filter(t => t.status === 'done').length;
    html += `<div class="card ${doneN === d.tasks.length ? 'ok' : ''}"><div class="row between"><h2>Задачи</h2><span class="tag ${doneN === d.tasks.length ? 'green' : ''}">${doneN} из ${d.tasks.length}</span></div>
      ${d.tasks.map(t => `<div class="task ${t.status === 'done' ? 'done' : ''}">
        <div class="t">${esc(t.text)}</div><div class="goalchip">→ ${esc(goalName(t.goalId))}</div>
        ${d.report ? '' : `<div class="seg">
          <button class="${t.status === 'todo' ? 'on' : ''}" data-act="tstat" data-id="${t.id}" data-v="todo">Не начал</button>
          <button class="${t.status === 'prog' ? 'on prog' : ''}" data-act="tstat" data-id="${t.id}" data-v="prog">В процессе</button>
          <button class="${t.status === 'done' ? 'on done' : ''}" data-act="tstat" data-id="${t.id}" data-v="done">Готово</button></div>`}
      </div>`).join('')}</div>`;
  }

  // 2. Проверка (check-in)
  if (d.planAt && !d.report) {
    let due = -1;
    // открыт только текущий отчёт; прошедшие уже засчитаны как пропущенные
    T.slots.forEach((t, i) => { if (t <= now) due = i; });
    if (due >= 0 && d.checkins[due]) due = -1;
    if (due >= 0) {
      const t = T.slots[due];
      const missedMin = Math.round((now - t) / 60000);
      html += `<div class="card alert"><div class="row between"><h2>Отчёт ${hm(t)}</h2><span class="tag red">${missedMin > 2 ? 'ОПОЗДАНИЕ ' + missedMin + ' МИН' : 'СЕЙЧАС'}</span></div>
        <p class="muted small">Что конкретно ты сделал с прошлой проверки? Обнови статус задач выше.</p>
        <textarea data-ci="${due}" placeholder="Сделал: ... Мешало: ...">${esc(draft['ci' + due] || '')}</textarea>
        <button class="btn" data-act="checkin" data-i="${due}">Отчитаться</button></div>`;
    } else {
      const next = T.slots.find(t => t > now);
      if (next) html += `<p class="muted small" style="margin:-4px 2px 14px">Следующая проверка в ${hm(next)}.</p>`;
    }
  }

  // 3. Привычки
  if (st.habits.length) {
    const hDone = st.habits.filter(h => d.habits[h.id]).length;
    html += `<div class="card"><div class="row between"><h2>Привычки</h2><span class="tag ${hDone === st.habits.length ? 'green' : ''}">${hDone} из ${st.habits.length}</span></div>
      ${st.habits.map(h => { const s = habitStreak(h.id, key); return `<div class="habit ${d.habits[h.id] ? 'on' : ''}" data-act="habit" data-id="${h.id}">
        <div class="check">✓</div><div class="grow">${esc(h.name)}</div>${s ? `<div class="streak">🔥 ${s}</div>` : ''}</div>`; }).join('')}</div>`;
  }

  // 4. Вечерний отчёт
  if (d.planAt && !d.report) {
    const open = now >= T.reportOpen || d.tasks.every(t => t.status === 'done');
    if (open) {
      const r = draft.report || (draft.report = { score: 0, fails: {}, lesson: '', tomorrow: '' });
      const undone = d.tasks.filter(t => t.status !== 'done');
      html += `<div class="card ${now >= T.report ? 'alert' : 'warn'}"><div class="row between"><h2>Вечерний отчёт</h2>${now >= T.report ? '<span class="tag red">СДАТЬ ДО ' + S.settings.bed + '</span>' : ''}</div>
        <p class="muted small">Честно. Себя обманывать бессмысленно.</p>
        ${undone.map(t => `<label>Почему не сделано: «${esc(t.text)}»?</label><textarea data-fail="${t.id}" placeholder="Настоящая причина, без оправданий">${esc(r.fails[t.id] || '')}</textarea>`).join('')}
        <label>Оценка дня (1–10)</label>
        <div class="rating">${Array.from({ length: 10 }, (_, i) => `<button class="${r.score === i + 1 ? 'on' : ''}" data-act="rate" data-v="${i + 1}">${i + 1}</button>`).join('')}</div>
        <label>Главный вывод дня</label><textarea data-rep="lesson" placeholder="Что завтра сделаешь иначе?">${esc(r.lesson)}</textarea>
        <label>Главная задача на завтра</label><input data-rep="tomorrow" value="${esc(r.tomorrow)}" placeholder="Появится в плане завтра первой">
        <button class="btn" data-act="report">Сдать отчёт</button></div>`;
    } else {
      html += `<p class="muted small" style="margin:0 2px 14px">Вечерний отчёт откроется в ${hm(T.reportOpen)}, сдать до ${S.settings.bed}.</p>`;
    }
  }

  if (d.report) {
    html += `<div class="card ok"><div class="row between"><h2>День закрыт</h2><span class="tag green">ОТЧЁТ СДАН</span></div>
      <p>${verdict(score)}</p><p class="muted small">Оценка дня: ${d.report.score}/10${d.report.tomorrow ? ' · Завтра первым: ' + esc(d.report.tomorrow) : ''}</p></div>`;
  }

  // 5. Лента отчётов
  const cis = Object.keys(d.checkins).map(Number).sort((a, b) => a - b);
  const missed = T.slots.map((t, i) => i).filter(i => !d.checkins[i] && (T.slots[i + 1] ? T.slots[i + 1] <= now : now >= T.report));
  if (cis.length || missed.length) {
    html += `<h3>Лента дня</h3><div class="card timeline">${T.slots.map((t, i) => d.checkins[i]
      ? `<div class="it"><div class="row between"><b>${hm(t)}</b><span class="muted small">сдан в ${esc(d.checkins[i].at)}</span></div><div class="small">${esc(d.checkins[i].text)}</div></div>`
      : missed.includes(i) ? `<div class="it"><div class="row between"><b>${hm(t)}</b><span class="tag red">ПРОПУЩЕН</span></div></div>` : '').join('')}</div>`;
  }
  return html;
}

function greet(now) {
  const h = now.getHours();
  return h < 5 ? 'почему не спишь?' : h < 12 ? 'доброе утро' : h < 18 ? 'работаем' : 'добиваем день';
}
function verdict(s) {
  if (s >= 85) return 'Сильный день. Так и держать — завтра не хуже.';
  if (s >= 70) return 'Нормально, но не идеально. Завтра — больше.';
  if (s >= 40) return 'Слабо. Ты можешь лучше, и ты это знаешь.';
  return 'Провал. Разберись, что пошло не так, и не повторяй.';
}

function defaultPlanDraft(key) {
  const g0 = S.settings.goals[0] ? S.settings.goals[0].id : '';
  const prev = S.days[shiftKey(key, -1)];
  const first = prev && prev.report && prev.report.tomorrow ? prev.report.tomorrow : '';
  return [0, 1, 2].map(i => ({ text: i === 0 ? first : '', goalId: S.settings.goals[i] ? S.settings.goals[i].id : g0 }));
}

/* ----- итоги ----- */
function renderStats() {
  const today = dayKey();
  const keys = Array.from({ length: 7 }, (_, i) => shiftKey(today, i - 6));
  const scores = keys.map(k => S.days[k] ? dayScore(k) : null);
  const valid = scores.filter(x => x !== null);
  const avg = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
  const keys30 = Array.from({ length: 30 }, (_, i) => shiftKey(today, -i));
  let tasks = 0, done = 0, reports = 0, plans = 0, ciDue = 0, ciDone = 0;
  const perGoal = {};
  keys30.forEach(k => {
    const d = S.days[k]; if (!d) return;
    if (d.planAt) plans++; if (d.report) reports++;
    d.tasks.forEach(t => { tasks++; if (t.status === 'done') done++; const g = perGoal[t.goalId] || (perGoal[t.goalId] = { t: 0, d: 0 }); g.t++; if (t.status === 'done') g.d++; });
    if (k !== today && d.planAt) { const n = times(k).slots.length; ciDue += n; ciDone += Object.keys(d.checkins).length; }
  });
  const streak = disciplineStreak(today);
  let html = `<h1>Итоги</h1><p class="muted">Цифры не врут.</p>
    <div class="card"><div class="row between"><h2>Последние 7 дней</h2><span class="tag ${avg >= 70 ? 'green' : avg >= 40 ? 'amber' : 'red'}">в среднем ${avg}</span></div>
    <div class="week">${keys.map((k, i) => { const s = scores[i]; const c = s === null ? 'n' : s >= 70 ? 'g' : s >= 40 ? 'a' : ''; return `<div class="d"><span class="lb">${s === null ? '–' : s}</span><div class="col ${c}" style="height:${s === null ? 3 : Math.max(3, s)}%"></div><span class="lb">${WD[dayStart(k).getDay()]}</span></div>`; }).join('')}</div></div>
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><b>${streak}</b><span>дней подряд с планом и отчётом</span></div>
      <div class="kpi"><b>${tasks ? Math.round(done / tasks * 100) : 0}%</b><span>задач выполнено за 30 дней</span></div>
      <div class="kpi"><b>${plans}</b><span>дней с планом из 30</span></div>
      <div class="kpi"><b>${ciDue ? Math.round(ciDone / ciDue * 100) : 0}%</b><span>отчётов сдано вовремя</span></div>
    </div>`;
  html += `<div class="card"><h2>Движение к целям</h2><p class="muted small">Выполненные задачи за 30 дней</p>
    ${S.settings.goals.map(g => { const p = perGoal[g.id] || { t: 0, d: 0 }; const pc = p.t ? Math.round(p.d / p.t * 100) : 0;
      return `<div style="margin-top:12px"><div class="row between"><span>${esc(g.name)}</span><span class="muted small">${p.d} из ${p.t}</span></div><div class="bar ${pc >= 70 ? 'g' : pc >= 40 ? 'a' : ''}"><i style="width:${pc}%"></i></div>${p.t === 0 ? '<div class="small" style="color:var(--red);margin-top:4px">Ни одной задачи. Цель заброшена.</div>' : ''}</div>`; }).join('')}</div>`;
  if (S.settings.habits.length) {
    html += `<div class="card"><h2>Привычки</h2>${S.settings.habits.map(h => {
      const n = keys.filter(k => S.days[k] && S.days[k].habits[h.id]).length;
      return `<div style="margin-top:10px"><div class="row between"><span>${esc(h.name)}</span><span class="muted small">${n}/7 · 🔥 ${habitStreak(h.id, today)}</span></div><div class="bar ${n >= 6 ? 'g' : n >= 4 ? 'a' : ''}"><i style="width:${n / 7 * 100}%"></i></div></div>`; }).join('')}</div>`;
  }
  // история
  const hist = keys30.filter(k => S.days[k] && (S.days[k].planAt || S.days[k].report)).slice(0, 14);
  if (hist.length) {
    html += `<h3>История</h3><div class="card timeline">${hist.map(k => { const d = S.days[k]; const s = dayScore(k);
      return `<div class="it"><div class="row between"><b>${prettyDate(k)}</b><span class="tag ${s >= 70 ? 'green' : s >= 40 ? 'amber' : 'red'}">${s}</span></div>
      <div class="small muted">${d.tasks.filter(t => t.status === 'done').length}/${d.tasks.length} задач${d.report ? ' · оценка ' + d.report.score + '/10' : ' · отчёт не сдан'}</div>
      ${d.report && d.report.lesson ? `<div class="small">${esc(d.report.lesson)}</div>` : ''}</div>`; }).join('')}</div>`;
  }
  return html;
}

/* ----- настройки ----- */
function renderSettings() {
  const st = S.settings;
  return `<h1>Настройки</h1>
  <div class="card">
    <label>Имя</label><input data-s="name" value="${esc(st.name)}">
    <div class="row"><div class="grow"><label>Подъём</label><input type="time" data-s="wake" value="${esc(st.wake)}"></div>
    <div class="grow"><label>Отбой</label><input type="time" data-s="bed" value="${esc(st.bed)}"></div></div>
    <div class="row"><div class="grow"><label>Работа с</label><input type="time" data-s="workStart" value="${esc(st.workStart)}"></div>
    <div class="grow"><label>Работа до</label><input type="time" data-s="workEnd" value="${esc(st.workEnd)}"></div></div>
    <label>Отчёт каждые</label>
    <div class="seg">${[2, 3, 4].map(h => `<button class="${st.checkEvery == h ? 'on' : ''}" data-act="sset" data-k="checkEvery" data-v="${h}">${h} часа</button>`).join('')}</div>
    <label>Дожимать через</label>
    <div class="seg">${[5, 10, 15].map(m => `<button class="${st.nagMin == m ? 'on' : ''}" data-act="sset" data-k="nagMin" data-v="${m}">${m} мин</button>`).join('')}</div>
    <button class="btn" data-act="savesettings">Сохранить</button>
  </div>
  <div class="card list-edit"><h2>Цели</h2>
    ${st.goals.map((g, i) => `<div class="row"><input data-sgoal="${i}" value="${esc(g.name)}"><button class="x" data-act="sdelgoal" data-i="${i}">✕</button></div>`).join('')}
    ${st.goals.length < 5 ? '<div class="row"><input id="sgoalnew" placeholder="Новая цель"><button class="btn sm ghost" data-act="saddgoal">Добавить</button></div>' : ''}
    <button class="btn ghost" data-act="savegoals">Сохранить цели</button>
  </div>
  <div class="card list-edit"><h2>Привычки</h2>
    ${st.habits.map((h, i) => `<div class="row"><input data-shabit="${i}" value="${esc(h.name)}"><button class="x" data-act="sdelhabit" data-i="${i}">✕</button></div>`).join('')}
    <div class="row"><input id="shabitnew" placeholder="Новая привычка"><button class="btn sm ghost" data-act="saddhabit">Добавить</button></div>
    <button class="btn ghost" data-act="savehabits">Сохранить привычки</button>
  </div>
  <div class="card"><h2>Уведомления</h2>
    <p class="muted small" id="exactstatus">Проверяю…</p>
    <button class="btn ghost" data-act="testnotif">Проверить: уведомление через 10 секунд</button>
    <button class="btn ghost" data-act="exact" id="exactbtn" hidden>Разрешить точные будильники</button>
    <p class="muted small" style="margin-top:12px">Открывай приложение хотя бы раз в день — так оно обновляет расписание напоминаний на 2 дня вперёд.${platform === 'android' ? ' Если напоминания опаздывают: Настройки телефона → Приложения → Контроль → Батарея → «Без ограничений».' : ''}</p>
  </div>
  <div class="card"><h2>Резервная копия</h2>
    <p class="muted small">Все данные хранятся только в телефоне. Перед удалением приложения или сменой телефона скопируй их.</p>
    <button class="btn ghost" data-act="export">Показать копию данных</button>
    <textarea id="backup" placeholder="Сюда можно вставить копию для восстановления" style="margin-top:10px;min-height:90px"></textarea>
    <div class="row"><button class="btn ghost" data-act="copybackup">Скопировать</button><button class="btn ghost" data-act="import">Восстановить</button></div>
  </div>
  <p class="muted small" style="text-align:center">Контроль · данные только на этом телефоне</p>`;
}

async function fillExactStatus() {
  const el = document.getElementById('exactstatus'), btn = document.getElementById('exactbtn');
  if (!el) return;
  if (!LN) { el.textContent = 'Уведомления работают только в установленном приложении.'; return; }
  const p = await notifPermission(false);
  let txt = p === 'granted' ? 'Уведомления разрешены.' : 'Уведомления ЗАПРЕЩЕНЫ — контроль не работает. Разреши их в настройках телефона.';
  if (platform === 'android' && LN.checkExactNotificationSetting) {
    try {
      const r = await LN.checkExactNotificationSetting();
      if (r.exact_alarm !== 'granted') { txt += ' Точные будильники выключены — напоминания могут опаздывать.'; btn.hidden = false; }
    } catch (e) {}
  }
  try { const pend = await LN.getPending(); txt += ' Запланировано напоминаний: ' + (pend.notifications || []).length + '.'; } catch (e) {}
  el.textContent = txt;
}

/* ---------- действия ---------- */
document.addEventListener('click', async e => {
  const navb = e.target.closest('#nav button');
  if (navb) { tab = navb.dataset.tab; draft = {}; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const key = dayKey(), d = S.settings.setupDone ? getDay(key) : null;

  switch (act) {
    // мастер
    case 'wnext': {
      wizCollect();
      const w = wiz.d;
      if (wiz.step === 2) {
        w.goals = w.goals.filter(g => g.name);
        if (!w.goals.length) { toast('Без цели некуда двигаться. Добавь хотя бы одну.'); if (!w.goals.length) w.goals.push({ id: uid(), name: '' }); render(); return; }
      }
      if (wiz.step === 1 && !wiz.d.goals.length) wiz.d.goals.push({ id: uid(), name: '' });
      wiz.step++; render(); window.scrollTo(0, 0); break;
    }
    case 'wback': wizCollect(); wiz.step = Math.max(0, wiz.step - 1); render(); break;
    case 'waddgoal': wizCollect(); wiz.d.goals.push({ id: uid(), name: '' }); render(); break;
    case 'wdelgoal': wizCollect(); wiz.d.goals.splice(+el.dataset.i, 1); render(); break;
    case 'wchip': {
      const h = el.dataset.h, i = wiz.d.habits.findIndex(x => x.name === h);
      if (i >= 0) wiz.d.habits.splice(i, 1); else wiz.d.habits.push({ id: uid(), name: h });
      render(); break;
    }
    case 'waddhabit': {
      const v = document.getElementById('newhabit').value.trim();
      if (v && !wiz.d.habits.some(x => x.name === v)) wiz.d.habits.push({ id: uid(), name: v });
      render(); break;
    }
    case 'wset': wiz.d[el.dataset.k] = Number(el.dataset.v); render(); break;
    case 'wfinish': {
      S.settings = Object.assign({}, wiz.d, { setupDone: true });
      wiz = { step: 0, d: null };
      save();
      await setupChannel();
      const p = await notifPermission(true);
      tab = 'today'; render();
      toast(p === 'granted' || !LN ? 'Контроль включён. Начинаем.' : 'Уведомления не разрешены — включи их в настройках телефона');
      break;
    }

    // сегодня
    case 'saveplan': {
      const items = draft.plan.map((t, i) => ({ text: (document.querySelector(`[data-plan="${i}"]`).value || '').trim(), goalId: document.querySelector(`[data-plangoal="${i}"]`).value }));
      if (items.some(t => t.text.length < 4)) { toast('Нужно 3 конкретные задачи. Без пустых строк.'); return; }
      d.tasks = items.map(t => ({ id: uid(), text: t.text, goalId: t.goalId, status: 'todo' }));
      d.planAt = hm(new Date()); draft = {};
      save(); render(); toast('План зафиксирован. Теперь выполняй.'); window.scrollTo(0, 0);
      break;
    }
    case 'tstat': {
      const t = d.tasks.find(x => x.id === el.dataset.id); if (!t) return;
      t.status = el.dataset.v; save(); render();
      if (t.status === 'done') toast(d.tasks.every(x => x.status === 'done') ? 'Все задачи закрыты. Сильно.' : 'Засчитано. Следующая.');
      break;
    }
    case 'checkin': {
      const i = el.dataset.i, txt = (document.querySelector(`[data-ci="${i}"]`).value || '').trim();
      if (txt.length < 10) { toast('Это не отчёт. Напиши конкретно, что сделал.'); return; }
      d.checkins[i] = { at: hm(new Date()), text: txt }; delete draft['ci' + i];
      save(); render(); toast('Отчёт принят.');
      break;
    }
    case 'habit': {
      const id = el.dataset.id; d.habits[id] = !d.habits[id]; if (!d.habits[id]) delete d.habits[id];
      save(); render(); break;
    }
    case 'rate': collectReport(); draft.report.score = Number(el.dataset.v); render(); break;
    case 'report': {
      collectReport(); const r = draft.report;
      const undone = d.tasks.filter(t => t.status !== 'done');
      if (undone.some(t => (r.fails[t.id] || '').trim().length < 5)) { toast('Объясни каждую невыполненную задачу.'); return; }
      if (!r.score) { toast('Поставь оценку дню.'); return; }
      if (r.lesson.trim().length < 5) { toast('Напиши вывод дня.'); return; }
      d.report = { at: hm(new Date()), score: r.score, fails: r.fails, lesson: r.lesson.trim(), tomorrow: r.tomorrow.trim() };
      draft = {}; save(); render(); window.scrollTo(0, 0); toast('Отчёт сдан. Теперь спать до ' + S.settings.bed + '.');
      break;
    }

    // настройки
    case 'sset': S.settings[el.dataset.k] = Number(el.dataset.v); save(); render(); break;
    case 'savesettings':
      document.querySelectorAll('[data-s]').forEach(x => { S.settings[x.dataset.s] = x.value; });
      save(); render(); toast('Сохранено. Расписание обновлено.'); break;
    case 'saddgoal': {
      collectGoals(); const v = document.getElementById('sgoalnew').value.trim();
      if (v) S.settings.goals.push({ id: uid(), name: v }); save(); render(); break;
    }
    case 'sdelgoal':
      if (S.settings.goals.length <= 1) { toast('Должна остаться хотя бы одна цель.'); return; }
      if (!confirm('Удалить цель? Старые задачи останутся в истории.')) return;
      collectGoals(); S.settings.goals.splice(+el.dataset.i, 1); save(); render(); break;
    case 'savegoals': collectGoals(); save(); render(); toast('Цели сохранены.'); break;
    case 'saddhabit': {
      collectHabits(); const v = document.getElementById('shabitnew').value.trim();
      if (v) S.settings.habits.push({ id: uid(), name: v }); save(); render(); break;
    }
    case 'sdelhabit': collectHabits(); S.settings.habits.splice(+el.dataset.i, 1); save(); render(); break;
    case 'savehabits': collectHabits(); save(); render(); toast('Привычки сохранены.'); break;
    case 'testnotif': {
      if (!LN) { toast('Работает только в установленном приложении.'); return; }
      const p = await notifPermission(true);
      if (p !== 'granted') { toast('Уведомления запрещены в настройках телефона.'); return; }
      await setupChannel();
      await LN.schedule({ notifications: [{ id: 999, title: 'Проверка связи', body: 'Контроль работает. Отговорок больше нет.', channelId: 'kontrol', schedule: { at: new Date(Date.now() + 10000), allowWhileIdle: true } }] });
      toast('Жди уведомление через 10 секунд. Можешь закрыть приложение.'); break;
    }
    case 'exact':
      try { await LN.changeExactNotificationSetting(); } catch (e) {}
      setTimeout(fillExactStatus, 1500); break;
    case 'export': document.getElementById('backup').value = JSON.stringify(S); toast('Скопируй текст и сохрани в заметках или отправь себе.'); break;
    case 'copybackup': {
      const ta = document.getElementById('backup');
      if (!ta.value) ta.value = JSON.stringify(S);
      try { await navigator.clipboard.writeText(ta.value); toast('Скопировано.'); }
      catch (e) { ta.select(); try { document.execCommand('copy'); toast('Скопировано.'); } catch (_) { toast('Выдели текст и скопируй вручную.'); } }
      break;
    }
    case 'import': {
      try {
        const data = JSON.parse(document.getElementById('backup').value);
        if (!data.settings || !data.days) throw 0;
        if (!confirm('Заменить все текущие данные этой копией?')) return;
        S = { settings: Object.assign({}, DEFAULTS, data.settings), days: data.days };
        save(); render(); toast('Данные восстановлены.');
      } catch (e) { toast('Это не похоже на копию данных Контроля.'); }
      break;
    }
  }
});

// сохраняем черновики при вводе, чтобы перерисовка не стирала текст
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.plan !== undefined && draft.plan) draft.plan[+el.dataset.plan].text = el.value;
  if (el.dataset.plangoal !== undefined && draft.plan) draft.plan[+el.dataset.plangoal].goalId = el.value;
  if (el.dataset.ci !== undefined) draft['ci' + el.dataset.ci] = el.value;
  if (el.dataset.fail !== undefined || el.dataset.rep !== undefined) collectReport();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.plangoal !== undefined && draft.plan) draft.plan[+el.dataset.plangoal].goalId = el.value;
});

function collectReport() {
  const r = draft.report || (draft.report = { score: 0, fails: {}, lesson: '', tomorrow: '' });
  document.querySelectorAll('[data-fail]').forEach(x => { r.fails[x.dataset.fail] = x.value; });
  document.querySelectorAll('[data-rep]').forEach(x => { r[x.dataset.rep] = x.value; });
}
function collectGoals() {
  document.querySelectorAll('[data-sgoal]').forEach(x => { const v = x.value.trim(); if (v) S.settings.goals[+x.dataset.sgoal].name = v; });
}
function collectHabits() {
  document.querySelectorAll('[data-shabit]').forEach(x => { const v = x.value.trim(); if (v) S.settings.habits[+x.dataset.shabit].name = v; });
}

/* ---------- жизненный цикл ---------- */
let lastKey = dayKey();
function refresh() {
  const k = dayKey();
  if (k !== lastKey) { lastKey = k; draft = {}; }
  const active = document.activeElement;
  const typing = active && /INPUT|TEXTAREA|SELECT/.test(active.tagName);
  if (!typing) render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); scheduleSoon(); } });
setInterval(refresh, 60000);

if (LN) {
  try {
    LN.addListener('localNotificationActionPerformed', ev => {
      const scr = ev && ev.notification && ev.notification.extra && ev.notification.extra.screen;
      tab = scr === 'stats' ? 'stats' : 'today'; render(); window.scrollTo(0, 0);
    });
  } catch (e) {}
}

render();
if (S.settings.setupDone) { setupChannel().then(rescheduleAll); }

// для проверки в браузере
window.__kontrol = { S: () => S, buildPlan, times, dayKey };

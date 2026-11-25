import { animationMs, buildRadar, drawRadar, ease, exportFrame } from './radar.js';

const ui = id => document.getElementById(id);
const roles = { TOP: '上单', JUNGLE: '打野', MIDDLE: '中单', BOTTOM: '下路', UTILITY: '辅助' };
const spells = { 1: '净化', 3: '虚弱', 4: '闪现', 6: '疾跑', 7: '治疗', 11: '惩戒', 12: '传送', 13: '清晰术', 14: '引燃', 21: '屏障', 32: '标记' };
const runes = { 8005: '强攻', 8008: '致命节奏', 8021: '迅捷步法', 8010: '征服者', 8112: '电刑', 8124: '掠食者', 8128: '黑暗收割', 9923: '丛刃', 8214: '艾黎', 8229: '奥术彗星', 8230: '相位猛冲', 8437: '不灭之握', 8439: '余震', 8465: '守护者', 8351: '冰川增幅', 8360: '启封的秘籍', 8369: '先攻' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const state = { catalog: { heroes: {} }, data: { matches: [] }, icons: { spell: [], rune: [] }, comparison: null, source: 'demo', generation: 0 };
const canvas = ui('radar');
const context = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let frame = 0, progress = 1, anchors = [], pointer = -1;
let exportBusy = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function fetchJSON(url, opts) {
  const response = await fetch(url, opts);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '无法读取战绩。');
  return body;
}

function message(text) { ui('message').textContent = text; ui('message').hidden = !text; }
function selectOptions(select, options, desired) {
  select.replaceChildren(...options.map(({ id, label }) => new Option(label, id)));
  select.disabled = !options.length;
  if (options.some(item => String(item.id) === String(desired))) select.value = desired;
}
const matchLength = match => match.duration > 0 ? `${Math.floor(match.duration / 60)}分${Math.floor(match.duration % 60)}秒` : '';
const matchDate = match => match.date ? dateFormat.format(new Date(match.date)) : `对局 ${match.id}`;
const queueLabel = match => ({ 420: '单/双排', 440: '灵活排位', 450: '极地大乱斗', 400: '匹配', 430: '匹配', 480: '迅捷模式' })[match.queue] || match.mode || '对局';
const hero = player => state.catalog.heroes[player.champion] ?? {};
const nameFor = player => player.name || (hero(player).name ? `${hero(player).name} · ${player.id}` : `选手 ${player.id}`);
const rank = player => ({ TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 })[player.role] ?? 9;
const playerOption = (id, player, suffix) => ({ id, label: `${nameFor(player)}${hero(player).name ? ` · ${hero(player).name}` : ''}${suffix ? ` · ${suffix}` : ''}` });

function views() {
  if (ui('mode').value === 'single') {
    const match = state.data.matches.find(item => item.id === ui('match').value);
    if (!match) return null;
    const groups = new Map(match.players.map(player => [player.id, [{ player, match }]]));
    return { match, groups, reference: [...groups.values()], aggregate: false };
  }
  const groups = new Map();
  for (const match of state.data.matches) {
    for (const player of match.players) {
      if (player.role !== ui('role').value || !player.identity) continue;
      if (!groups.has(player.identity)) groups.set(player.identity, []);
      groups.get(player.identity).push({ player, match });
    }
  }
  return { groups, reference: [...groups.values()], aggregate: true };
}

function changePlayers(reset = false, previous = views()) {
  if (!previous) return render();
  const { groups, aggregate } = previous;
  const sorted = [...groups].sort((a, b) => a[1][0].player.team - b[1][0].player.team || rank(a[1][0].player) - rank(b[1][0].player));
  const options = sorted.map(([id, entries]) => playerOption(id, entries[0].player, aggregate ? `${entries.length} 场` : roles[entries[0].player.role]));
  const owned = sorted.find(([, entries]) => entries[0].player.identity === state.data.owner && state.data.owner);
  const best = owned ?? sorted.find(([, entries]) => entries[0].player.role === 'MIDDLE') ?? sorted[0];
  selectOptions(ui('player-a'), options, reset ? best?.[0] : ui('player-a').value);
  const left = groups.get(ui('player-a').value)?.[0].player;
  const rivals = sorted.filter(([id, entries]) => id !== ui('player-a').value && (aggregate || entries[0].player.team !== left?.team));
  const counterpart = rivals.find(([, entries]) => left?.role && entries[0].player.role === left.role) ?? rivals[0];
  const priorB = ui('player-b').value;
  const preferredB = !reset && rivals.some(([id]) => id === priorB) ? priorB : counterpart?.[0];
  selectOptions(ui('player-b'), rivals.map(([id, entries]) => playerOption(id, entries[0].player, aggregate ? `${entries.length} 场` : roles[entries[0].player.role])), preferredB);
  render(previous);
}

function setDataset(dataset, source) {
  state.data = dataset; state.source = source;
  state.icons = dataset.icons ?? { spell: [], rune: [] };
  ui('source').textContent = { demo: '演示数据', local: '本机客户端', import: '导入战绩' }[source];
  ui('source').parentElement.classList.toggle('live', source === 'local');
  selectOptions(ui('match'), dataset.matches.map(match => ({ id: match.id, label: [matchDate(match), queueLabel(match), matchLength(match)].filter(Boolean).join(' · ') })));
  if (source === 'demo') { ui('mode').value = 'single'; ui('role').value = 'MIDDLE'; }
  onMode();
}

function fields(entries, aggregate) {
  const player = entries[0].player;
  const data = hero(player);
  const kda = item => [item.kills, item.deaths, item.assists].map(v => v ?? '–').join(' / ');
  const win = entries.filter(item => item.player.win !== null);
  const stat = aggregate ? win.length ? `${Math.round(win.filter(item => item.player.win).length * 100 / win.length)}% 胜率` : `${entries.length} 场` : kda(player);
  const champion = data.name || (player.champion ? `英雄 ${player.champion}` : '英雄未知');
  const items = [...player.spells.map(id => ['spell', id]), ['rune', player.keystone]].filter(([, id]) => id);
  const loadout = items.map(([kind, id]) => {
    const local = state.catalog.loadout?.[kind]?.[id];
    const name = local?.name || (kind === 'spell' ? spells : runes)[id] || `${kind === 'spell' ? '技能' : '符文'} ${id}`;
    const localUrl = local?.local ? `/loadout/${kind}/${id}.png` : '';
    const image = state.icons[kind]?.includes(String(id)) ? `/api/icon/${kind}/${id}` : localUrl;
    return { name, image, localUrl };
  });
  return { player, name: nameFor(player), champion, art: data.loading || data.splash, stat, entries, aggregate, loadout };
}

function renderCard(id, card, index) {
  const container = ui(id);
  container.replaceChildren();
  if (!card) { container.append(element('span', 'card-label', `选手 ${'AB'[index]}`)); return; }
  if (card.art) {
    const img = element('img', 'portrait'); img.src = card.art; img.alt = '';
    img.onerror = () => img.remove(); container.append(img);
  }
  const label = [card.aggregate ? `最近一局 · 共 ${card.entries.length} 场` : card.player.team === 100 ? '蓝色方' : card.player.team === 200 ? '红色方' : `队伍 ${card.player.team}`, roles[card.player.role]].filter(Boolean).join(' · ');
  container.append(element('div', 'portrait-shade'), element('span', 'card-label', label));
  const text = element('div');
  text.append(element('div', 'card-name', card.name), element('div', 'card-champ', card.champion));
  const stats = element('div', 'card-stat');
  stats.append(element('strong', '', card.stat));
  if (!card.aggregate) stats.append(element('span', '', ['K / D / A', card.player.win === true ? '胜利' : card.player.win === false ? '失败' : ''].filter(Boolean).join(' · ')));
  text.append(stats);
  const loadout = element('div', 'loadout');
  for (const { name, image, localUrl } of card.loadout) {
    const fallback = element('span', '', name);
    if (!image) { loadout.append(fallback); continue; }
    const img = element('img'); img.src = image; img.alt = name; img.title = name;
    img.onerror = () => {
      if (localUrl && !img.src.endsWith(localUrl)) img.src = localUrl;
      else img.replaceWith(fallback);
    };
    loadout.append(img);
  }
  text.append(loadout); container.append(text);
}

function render(view = views()) {
  const a = view?.groups.get(ui('player-a').value);
  const b = view?.groups.get(ui('player-b').value);
  if (!view || !a || !b) {
    state.comparison = null;
    ui('column-a').textContent = '选手 A'; ui('column-b').textContent = '选手 B';
    renderCard('card-a', a ? fields(a, view.aggregate) : null, 0); renderCard('card-b', b ? fields(b, view.aggregate) : null, 1);
    ui('sample').textContent = '请选择两位可比较的选手';
    ui('scale').textContent = view?.aggregate ? '这个位置需要两位有身份数据的选手' : '对比需要双方选手的战绩';
    ui('metrics').replaceChildren(); ui('method').textContent = ''; setButtons(); paint(); return;
  }
  const { aggregate, match, reference } = view;
  const cards = [fields(a, aggregate), fields(b, aggregate)];
  const model = buildRadar(a, b, reference, aggregate);
  const prefix = { demo: '演示数据', local: '客户端战绩', import: '导入数据' }[state.source];
  const subtitle = aggregate ? `${prefix} · ${roles[ui('role').value]} · ${a.length} 场 vs ${b.length} 场` : [prefix, matchDate(match), queueLabel(match), matchLength(match)].filter(Boolean).join(' · ');
  state.comparison = { model, cards, subtitle };
  renderCard('card-a', cards[0], 0); renderCard('card-b', cards[1], 1);
  ui('sample').textContent = aggregate ? `A ${a.length} 场 · B ${b.length} 场` : matchLength(match);
  ui('scale').textContent = aggregate ? '以同位置选手平均值为参考' : '以本场选手为参考';
  ['a', 'b'].forEach((letter, index) => { ui(`column-${letter}`).textContent = cards[index].name; });
  ui('metrics').replaceChildren(...model.axes.map(axis => {
    const row = element('tr'); row.append(element('td', '', axis.name), ...axis.cells.map(value => element('td', '', value))); return row;
  }));
  ui('method').textContent = '伤害占比和参团率按各自队伍计算。队伍总量为零时记 0%。每死承伤除以死亡数，零死亡时除以 1。生存为按时长折算的表现指标，100 ÷（1 + 10 × 每分钟死亡数）。多场模式先把经济、补刀、伤害和参与击杀按分钟折算，再对各场等权取平均。百分比轴上限为 100%，其余轴以当前参考组最高值为满刻度。缺失指标显示「—」。';
  setButtons(); replay();
}

function paint() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  anchors = drawRadar(context, 0, 0, width, height, state.comparison?.model, progress, pointer);
}
function replay() {
  cancelAnimationFrame(frame); pointer = -1;
  if (reduceMotion.matches) { progress = 1; paint(); return; }
  progress = 0; paint();
  const start = performance.now();
  function tick(time) {
    progress = ease(Math.max(0, time - start) / animationMs); paint();
    if (progress < 1) frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
}
new ResizeObserver(paint).observe(canvas.parentElement);
canvas.addEventListener('pointermove', event => {
  const index = anchors.findIndex(([x, y]) => Math.abs(event.offsetX - x) < 34 && Math.abs(event.offsetY - y) < 13);
  if (index !== pointer) { pointer = index; paint(); }
  const axis = state.comparison?.model.axes[pointer];
  canvas.title = axis ? `${axis.name}\nA ${axis.cells[0]} · B ${axis.cells[1]}` : '';
});
canvas.addEventListener('pointerleave', () => { pointer = -1; paint(); });

function setButtons() {
  for (const id of ['png', 'video', 'replay']) ui(id).disabled = !state.comparison || exportBusy;
}
function onMode() {
  const multi = ui('mode').value === 'aggregate';
  ui('match-field').hidden = multi; ui('role-field').hidden = !multi;
  changePlayers(true);
}
ui('mode').addEventListener('change', onMode);
for (const id of ['match', 'role', 'player-a']) ui(id).addEventListener('change', () => changePlayers(id !== 'player-a'));
ui('player-b').addEventListener('change', () => render());
ui('replay').addEventListener('click', replay);

async function getData(task, source) {
  const generation = ++state.generation;
  message('');
  try {
    const data = await task();
    if (generation !== state.generation) return;
    if (!data.matches.length) throw new Error('没有读到可用的对局。');
    setDataset(data, source);
    if (source === 'local') {
      const complete = data.matches.filter(match => new Set(match.players.map(p => p.team)).size > 1).length;
      message(`已读取 ${data.matches.length} 场，包含双方数据 ${complete} 场。`);
    }
  } catch (error) { if (generation === state.generation) message(error.message); }
}
const demo = () => getData(() => fetchJSON('/api/demo'), 'demo');
ui('demo').addEventListener('click', demo);
ui('sync').addEventListener('click', async () => {
  const sync = ui('sync'); sync.disabled = true; sync.textContent = '同步中…';
  try { await getData(() => fetchJSON('/api/history'), 'local'); }
  finally { sync.disabled = false; sync.textContent = '同步战绩'; }
});
ui('upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (file.size > 32 * 1024 * 1024) { message('JSON 文件应小于 32 MB。'); return; }
  await getData(() => fetchJSON('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file }), 'import');
});
const uploadLabel = document.querySelector('label[for="upload"]');
uploadLabel.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); ui('upload').click(); } });

function save(blob, filename) {
  const link = element('a'); link.download = filename;
  const url = URL.createObjectURL(blob); link.href = url; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function download(video) {
  if (exportBusy || !state.comparison) return;
  exportBusy = true; setButtons();
  let stream;
  try {
    const { model, cards, subtitle } = state.comparison;
    const frame = await exportFrame(model, cards, subtitle);
    if (!video) {
      const image = await new Promise(resolve => frame.canvas.toBlob(resolve, 'image/png'));
      if (!image) throw new Error('无法生成图片。');
      save(image, 'lol-radar.png'); return;
    }
    if (!window.MediaRecorder || !frame.canvas.captureStream) throw new Error('浏览器不支持动画录制，请用 Edge 或 Chrome 打开。');
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('浏览器不支持 WebM 动画录制。');
    ui('video').textContent = '正在录制…';
    frame.draw(0);
    stream = frame.canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      recorder.onerror = () => reject(new Error('无法导出动画。'));
    });
    recorder.start();
    const start = performance.now();
    function tick(time) {
      if (recorder.state !== 'recording') return;
      const elapsed = Math.max(0, time - start);
      frame.draw(ease(elapsed / animationMs));
      if (elapsed < animationMs + 900) requestAnimationFrame(tick);
      else recorder.stop();
    }
    requestAnimationFrame(tick);
    save(await done, 'lol-radar.webm');
  } catch (error) { message(error.message); }
  finally { stream?.getTracks().forEach(track => track.stop()); exportBusy = false; ui('video').textContent = '导出动画'; setButtons(); }
}
ui('png').addEventListener('click', () => download(false));
ui('video').addEventListener('click', () => download(true));
setButtons();
try {
  state.catalog = await fetchJSON('/api/catalog');
  ui('version').textContent = state.catalog.version ? `${state.catalog.version} · ${Object.keys(state.catalog.heroes).length} 英雄` : '未加载';
} catch { ui('version').textContent = '未加载'; }
await demo();

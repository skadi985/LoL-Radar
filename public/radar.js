const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const colors = ['#78e0ac', '#f3bd83'];
const axisNames = ['伤害占比', '每死承伤', '经济', '补刀', '参团率', '生存', '伤害', '参与击杀'];

export function valuesFor(player, match) {
  const team = match.players.filter(p => p.team === player.team);
  const sum = key => team.length > 1 && team.every(p => p[key] !== null) ? team.reduce((total, p) => total + p[key], 0) : null;
  const damage = sum('damage');
  const kills = sum('kills');
  const participation = player.kills === null || player.assists === null ? null : player.kills + player.assists;
  const minutes = match.duration > 0 ? match.duration / 60 : null;
  const values = [
    damage === null || player.damage === null ? null : damage ? 100 * player.damage / damage : 0,
    player.taken === null || player.deaths === null ? null : player.taken / Math.max(1, player.deaths),
    player.gold, player.cs,
    kills === null || participation === null ? null : kills ? 100 * participation / kills : 0,
    minutes === null || player.deaths === null ? null : 100 / (1 + 10 * player.deaths / minutes),
    player.damage, participation,
  ];
  return { values, minutes };
}

export function buildRadar(a, b, reference, aggregate) {
  const mean = samples => axisNames.map((_, i) => {
    const values = samples.map(({player, match}) => {
      const { values, minutes } = valuesFor(player, match);
      const value = values[i];
      if (!aggregate || ![2, 3, 6, 7].includes(i)) return value;
      return minutes && value !== null ? value / minutes : null;
    }).filter(v => v !== null);
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  });
  const groups = [mean(a), mean(b)];
  const referenceValues = reference.map(group => mean(group));
  const axes = axisNames.map((name, i) => {
    const percent = [0, 4, 5].includes(i);
    const ceiling = percent ? 100 : Math.max(1, ...referenceValues.map(v => v[i] ?? 0), ...groups.map(v => v[i] ?? 0));
    const display = value => value === null ? '—' : fmt.format(value) + (percent ? '%' : aggregate && [2, 3, 6, 7].includes(i) ? ' / 分' : '');
    return { name, cells: groups.map(v => display(v[i])), radius: groups.map(v => v[i] === null ? null : Math.min(1, v[i] / ceiling)) };
  });
  return { axes };
}

function polygon(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
}

export function drawRadar(ctx, x, y, width, height, model, progress, pointer = -1) {
  if (!model) return [];
  const cx = x + width / 2;
  const cy = y + height / 2;
  const radius = Math.max(30, Math.min((width - 125) / 2, (height - 67) / 2));
  const point = (i, r) => [cx + Math.sin(i * Math.PI / 4) * r, cy - Math.cos(i * Math.PI / 4) * r];
  const far = model.axes.map((_, i) => point(i, radius));
  ctx.save();
  ctx.lineWidth = 1;
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    polygon(ctx, model.axes.map((_, i) => point(i, radius * fraction)));
    ctx.strokeStyle = fraction === 1 ? '#567060' : '#3a5143';
    ctx.stroke();
  }
  for (const [ax, ay] of far) {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay); ctx.strokeStyle = '#395042'; ctx.stroke();
  }
  for (let j = 1; j >= 0; j--) {
    const points = model.axes.map((axis, i) => axis.radius[j] === null ? null : point(i, axis.radius[j] * radius * progress));
    ctx.strokeStyle = colors[j]; ctx.lineWidth = 2;
    if (points.every(Boolean)) {
      polygon(ctx, points); ctx.fillStyle = colors[j] + '36'; ctx.fill(); ctx.stroke();
    } else {
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        if (!p || !q) return;
        ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
      });
    }
    ctx.fillStyle = colors[j];
    for (const p of points.filter(Boolean)) {
      ctx.beginPath(); ctx.arc(...p, 2.8, 0, 2 * Math.PI); ctx.fill();
    }
  }
  ctx.font = '600 12px "Microsoft YaHei UI", "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const anchors = model.axes.map((axis, i) => {
    const [ax, ay] = point(i, radius + (i % 2 ? 36 : 29));
    const tx = Math.max(x + 31, Math.min(x + width - 31, ax));
    ctx.fillStyle = i === pointer ? '#fff' : '#c2cec4';
    ctx.fillText(axis.name, tx, ay);
    return [tx, ay];
  });
  ctx.restore();
  return anchors;
}

export function ease(t) { return 1 - Math.pow(1 - Math.min(t, 1), 3); }
export const animationMs = 1200;

export async function exportFrame(model, cards, subtitle) {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const loadImage = url => new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url;
  });
  const pictures = await Promise.all(cards.map(card => loadImage(card.art)));
  const loadout = await Promise.all(cards.map(card => Promise.all(card.loadout.map(async ({image, localUrl}) =>
    (await loadImage(image)) ?? (localUrl !== image ? await loadImage(localUrl) : null)))));
  function draw(progress) {
    ctx.fillStyle = '#101310'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#e9eee5'; ctx.font = 'bold 38px "Microsoft YaHei UI",sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('峡谷对位 · 战绩雷达', 35, 60, 1180);
    ctx.fillStyle = '#acb5a9'; ctx.font = '17px "Microsoft YaHei UI",sans-serif'; ctx.fillText(subtitle, 35, 90, 1180);
    cards.forEach((card, i) => {
      const x = i === 0 ? 35 : 965;
      ctx.save(); ctx.beginPath(); ctx.roundRect(x, 120, 280, 550, 12); ctx.clip();
      ctx.fillStyle = '#202923'; ctx.fillRect(x, 120, 280, 550);
      const img = pictures[i];
      if (img) {
        const scale = Math.max(280 / img.width, 550 / img.height);
        ctx.drawImage(img, x + (280 - img.width * scale) / 2, 120, img.width * scale, img.height * scale);
      }
      const shade = ctx.createLinearGradient(x, 280, x, 670);
      shade.addColorStop(0, '#12181200'); shade.addColorStop(.76, '#121812eb'); shade.addColorStop(1, '#121812');
      ctx.fillStyle = shade; ctx.fillRect(x, 280, 280, 390);
      ctx.fillStyle = colors[i]; ctx.font = '18px "Microsoft YaHei UI",sans-serif'; ctx.fillText(card.champion, x + 20, 538, 240);
      ctx.fillStyle = '#e9eee5'; ctx.font = 'bold 26px "Microsoft YaHei UI",sans-serif'; ctx.fillText(card.name, x + 20, 578, 240);
      ctx.fillStyle = colors[i]; ctx.font = '19px "Microsoft YaHei UI",sans-serif'; ctx.fillText(card.stat, x + 20, 608, 240);
      loadout[i].forEach((icon, slot) => { if (icon) ctx.drawImage(icon, x + 20 + slot * 34, 623, 28, 28); });
      ctx.restore();
    });
    ctx.fillStyle = '#19231c'; ctx.beginPath(); ctx.roundRect(331, 120, 618, 550, 12); ctx.fill();
    drawRadar(ctx, 331, 130, 618, 382, model, progress);
    model.axes.forEach((axis, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 353 + col * 303;
      const y = 530 + row * 32;
      ctx.font = '15px "Microsoft YaHei UI",sans-serif';
      ctx.textAlign = 'left'; ctx.fillStyle = '#c7d1c7'; ctx.fillText(axis.name, x, y);
      ctx.textAlign = 'right'; ctx.fillStyle = colors[0]; ctx.fillText(axis.cells[0], x + 170, y);
      ctx.fillStyle = colors[1]; ctx.fillText(axis.cells[1], x + 266, y);
    });
  }
  draw(1);
  return { canvas, draw };
}

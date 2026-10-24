'use strict';
/* Penderie — appli garde-robe hors ligne. Tout est stocké sur l'appareil (IndexedDB). */

/* ---------- référentiels ---------- */
const CATS = [['haut', 'Hauts'], ['veste', 'Vestes'], ['bas', 'Bas'], ['chaussure', 'Chaussures'], ['accessoire', 'Accessoires']];
const CAT_ONE = { haut: 'Haut', veste: 'Veste', bas: 'Bas', chaussure: 'Chaussures', accessoire: 'Accessoire' };
const CAT_POS = { haut: 't', veste: 't', bas: 'b', chaussure: 's', accessoire: 'a' };
const OCCS = [['quotidien', 'Quotidien'], ['sortie', 'Sortie'], ['soiree', 'Soirée']];
const OCC_LABEL = Object.fromEntries(OCCS);
const COLORS = {
  blanc: ['Blanc', '#F4F4F2'], noir: ['Noir', '#1E1E1E'], gris: ['Gris', '#9A9DA3'], beige: ['Beige', '#D8C7A3'],
  marine: ['Marine', '#22304F'], marron: ['Marron', '#6B4428'], kaki: ['Kaki', '#6E7350'], moutarde: ['Moutarde', '#C8901A'],
  bleu_moyen: ['Bleu moyen', '#5872A8'], bleu_clair: ['Bleu clair', '#9EC1E0'], rose: ['Rose', '#E7A6B4'], rouge: ['Rouge', '#B8322A'],
  jaune: ['Jaune', '#E8C22E'], turquoise: ['Turquoise', '#3FB5AE'], vert: ['Vert', '#3E7D4E'], bordeaux: ['Bordeaux', '#6E1F2A'],
  orange: ['Orange', '#E07B2A'], violet: ['Violet', '#6B4A8E'],
};
const FORMALITY = ['', 'détente', 'décontracté', 'soigné', 'habillé', 'costume'];

/* règles de couleurs reprises de « Style · Fred » */
const NEUTRALS = new Set(['blanc', 'noir', 'gris', 'beige', 'marine', 'marron']);
const pairKey = (a, b) => [a, b].sort().join('|');
const ACCENT_PAIRS = new Set([['kaki', 'moutarde'], ['kaki', 'bleu_moyen'], ['moutarde', 'bleu_moyen'], ['moutarde', 'bleu_clair'], ['rose', 'bleu_clair']].map(p => pairKey(...p)));
const CLASH = new Set([['rouge', 'rose'], ['rouge', 'jaune'], ['jaune', 'rose'], ['turquoise', 'rose'], ['turquoise', 'jaune'], ['moutarde', 'rouge'], ['kaki', 'rose'], ['kaki', 'turquoise'], ['kaki', 'jaune']].map(p => pairKey(...p)));

/* repères photo par défaut (fractions de l'image) : cut = bas du haut / ceinture du bas, l-r = largeur des hanches */
const DEF_CALIB = { haut: { cut: .44, l: .2, r: .78 }, veste: { cut: .46, l: .18, r: .8 }, bas: { cut: .36, l: .27, r: .74, ankle: .87 } };

const occFromFormality = f => f <= 2 ? ['quotidien'] : f === 3 ? ['quotidien', 'sortie'] : f === 4 ? ['sortie', 'soiree'] : ['soiree'];
const SECTION_OCC = { k: 'quotidien', s: 'sortie', c: 'soiree' };

/* ---------- stockage ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('penderie', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('pieces', { keyPath: 'id' });
        d.createObjectStore('outfits', { keyPath: 'id' });
        d.createObjectStore('worn', { keyPath: 'id' });
        d.createObjectStore('kv');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      let out;
      const r = fn(t.objectStore(store));
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  all(s) { return this.tx(s, 'readonly', st => st.getAll()); },
  get(s, k) { return this.tx(s, 'readonly', st => st.get(k)); },
  put(s, v) { return this.tx(s, 'readwrite', st => st.put(v)); },
  putMany(s, arr) { return this.tx(s, 'readwrite', st => { arr.forEach(v => st.put(v)); }); },
  del(s, k) { return this.tx(s, 'readwrite', st => st.delete(k)); },
  clear(s) { return this.tx(s, 'readwrite', st => st.clear()); },
  setKV(k, v) { return this.tx('kv', 'readwrite', st => st.put(v, k)); },
  getKV(k) { return this.tx('kv', 'readonly', st => st.get(k)); },
};

/* ---------- état ---------- */
const S = {
  pieces: [], outfits: [], worn: [],
  view: 'today', param: null,
  dressCat: 'all', dressSearch: '', outfitOcc: 'all',
  today: null, draft: null, calibDraft: null, addDraft: null,
};
const byId = id => S.pieces.find(p => p.id === id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const calibOf = p => ({ ...(DEF_CALIB[p.category] || {}), ...((window.CALIB_PRESETS || {})[p.id] || {}), ...(p.calib || {}) });
const SLOTS = ['veste', 'haut', 'bas', 'chaussure', 'accessoire'];

async function loadAll() {
  [S.pieces, S.outfits, S.worn] = await Promise.all([DB.all('pieces'), DB.all('outfits'), DB.all('worn')]);
  S.pieces.sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  S.outfits.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.title.localeCompare(b.title, 'fr'));
  S.today = await DB.getKV('today');
}

/* ---------- moteur « habille-moi » ---------- */
function scorePair(a, b) {
  let s = 0;
  if (a.color === b.color) s += 1;
  else if (NEUTRALS.has(a.color) || NEUTRALS.has(b.color)) s += 2;
  else if (ACCENT_PAIRS.has(pairKey(a.color, b.color))) s += 3;
  else if (CLASH.has(pairKey(a.color, b.color))) s -= 5;
  const gap = Math.abs(a.formality - b.formality);
  s += gap <= 1 ? 1 : gap === 2 ? -2 : -6;
  return s;
}
function scoreOutfit(list) {
  let s = 0;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) s += scorePair(list[i], list[j]);
  return s;
}
function pool(cat, occ) {
  const all = S.pieces.filter(p => p.category === cat && p.state !== 'donner');
  const fit = all.filter(p => (p.occasions || []).includes(occ));
  return fit.length ? fit : all;
}
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function generate(occ, locked = {}) {
  const chance = { veste: { quotidien: .2, sortie: .35, soiree: .75 }, accessoire: { quotidien: .3, sortie: .1, soiree: 0 } };
  const want = {
    veste: !!locked.veste || Math.random() < chance.veste[occ],
    accessoire: !!locked.accessoire || Math.random() < chance.accessoire[occ],
  };
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 80; i++) {
    const o = {};
    for (const slot of SLOTS) {
      if ((slot === 'veste' || slot === 'accessoire') && !want[slot]) continue;
      const p = locked[slot] ? byId(locked[slot]) : pick(pool(slot, occ));
      if (p) o[slot] = p;
    }
    const sc = scoreOutfit(Object.values(o)) + Math.random() * 3;
    if (sc > bestScore) { bestScore = sc; best = o; }
  }
  return Object.fromEntries(Object.entries(best || {}).map(([k, p]) => [k, p.id]));
}
function itemsToSlots(ids) {
  const o = {};
  // une veste listée après une autre (gilet puis veste) est la couche du dessus : elle prend la place
  ids.map(byId).filter(Boolean).forEach(p => { if (!o[p.category] || p.category === 'veste') o[p.category] = p.id; });
  return o;
}
const slotsToIds = slots => SLOTS.map(s => slots[s]).filter(Boolean);

/* ---------- silhouette recomposée ---------- */
const imgCache = new Map();
function imgOf(p) {
  if (!imgCache.has(p.id + p.photoV)) {
    imgCache.set(p.id + p.photoV, new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = p.photo; }));
  }
  return imgCache.get(p.id + p.photoV);
}
async function drawSilhouette(canvas, slots, W, overrides = {}) {
  const P = s => slots[s] ? byId(slots[s]) : null;
  const top = P('veste') || P('haut'), under = P('veste') ? P('haut') : null, bot = P('bas'), shoe = P('chaussure'), acc = P('accessoire');
  const [ti, ui, bi, si, ai] = await Promise.all([top, under, bot, shoe, acc].map(p => p ? imgOf(p) : null));
  const cal = p => ({ ...calibOf(p), ...(overrides[p.id] || {}) });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const hipW = W * .56, cx = W / 2;
  const parts = [];
  let y = 0;
  if (ti) {
    const c = cal(top), s = hipW / ((c.r - c.l) * ti.width);
    const h = c.cut * ti.height * s;
    parts.push({ img: ti, sx: 0, sy: 0, sw: ti.width, sh: c.cut * ti.height, dx: cx - (c.l + c.r) / 2 * ti.width * s, dy: 0, dw: ti.width * s, dh: h, z: 2 });
    y = h;
  }
  if (bi) {
    const c = cal(bot), s = hipW / ((c.r - c.l) * bi.width);
    const ankle = shoe ? (c.ankle ?? .87) : 1;
    const sy = c.cut * bi.height, sh = (ankle - c.cut) * bi.height;
    const dy = Math.max(0, y - W * .045); // le haut recouvre le haut du bas, comme un t-shirt porté par-dessus
    parts.push({ img: bi, sx: 0, sy, sw: bi.width, sh, dx: cx - (c.l + c.r) / 2 * bi.width * s, dy, dw: bi.width * s, dh: sh * s, z: 1 });
    y = dy + sh * s;
  }
  // chaussures : les photos sont des gros plans vus d'en haut, on les montre dans un encadré au niveau des pieds
  let shoeBox = null;
  if (si) {
    const bw = hipW * 1.15, bh = W * .3;
    shoeBox = { x: cx - bw / 2, y: Math.max(0, y - bh * .25), w: bw, h: bh };
    y = shoeBox.y + bh + 6;
  }
  const H = Math.max(Math.round(y), Math.round(W * 1.2));
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--photo').trim() || '#ECEAE6';
  g.fillRect(0, 0, W, H);
  if (!parts.length) {
    g.fillStyle = '#6B7185'; g.font = '14px system-ui'; g.textAlign = 'center';
    g.fillText('Aucune pièce', W / 2, H / 2);
    return;
  }
  parts.sort((a, b) => a.z - b.z).forEach(p => g.drawImage(p.img, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh));
  if (shoeBox) {
    const b = shoeBox, ratio = b.w / b.h;
    let sw = si.width, sh = sw / ratio;
    if (sh > si.height) { sh = si.height; sw = sh * ratio; }
    const sx = (si.width - sw) / 2, sy = Math.min(si.height - sh, Math.max(0, si.height * .62 - sh / 2));
    g.save();
    g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 12); g.closePath(); g.clip();
    g.drawImage(si, sx, sy, sw, sh, b.x, b.y, b.w, b.h);
    g.restore();
    g.lineWidth = 2; g.strokeStyle = '#C8901A';
    g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 12); g.stroke();
  }
  const vignette = (img, x, pos) => {
    const v = W * .26, r = 10;
    g.save();
    g.beginPath(); g.roundRect(x, 8, v, v, r); g.closePath();
    g.fillStyle = '#fff'; g.fill(); g.clip();
    const sh = img.width; const sy = Math.max(0, Math.min(img.height - sh, img.height * pos - sh / 2));
    g.drawImage(img, 0, sy, img.width, sh, x, 8, v, v);
    g.restore();
    g.lineWidth = 2; g.strokeStyle = '#C8901A';
    g.beginPath(); g.roundRect(x, 8, v, v, r); g.stroke();
  };
  if (ui) vignette(ui, 8, .28);
  if (ai) vignette(ai, W - W * .26 - 8, .4);
}
function drawAll() {
  document.querySelectorAll('canvas.sil').forEach(c => {
    const ids = (c.dataset.items || '').split(',').filter(Boolean);
    drawSilhouette(c, itemsToSlots(ids), +c.dataset.w || 300);
  });
}
const silCanvas = (ids, w) => `<canvas class="sil" data-items="${esc(ids.join(','))}" data-w="${w}" width="${w}" height="${Math.round(w * 1.6)}"></canvas>`;

/* ---------- import de « Style · Fred » ---------- */
async function importStyleFred(text) {
  const start = text.indexOf('const DATA = ');
  if (start < 0) throw new Error('Ce fichier ne contient pas les données de « Style · Fred ».');
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  const json = text.slice(start + 13, end).trim().replace(/;$/, '');
  const data = JSON.parse(json);
  const existing = new Set(S.pieces.map(p => p.id));
  const pieces = (data.PIECES || []).filter(p => !existing.has(p.id) && data.IMGS?.[p.id]).map(p => ({
    id: p.id, label: p.label, category: p.category, color: p.color, formality: p.formality || 3,
    occasions: occFromFormality(p.formality || 3), photo: data.IMGS[p.id], photoV: 1,
    calib: null, wornCount: 0, lastWorn: null, state: 'bon', source: 'style-fred', createdAt: Date.now(),
  }));
  await DB.putMany('pieces', pieces);
  await loadAll();
  const known = new Set(S.pieces.map(p => p.id));
  const existingO = new Set(S.outfits.map(o => o.id));
  const mkOutfit = (o, id, order) => {
    const items = (o.items || []).map(i => i.key).filter(k => known.has(k));
    const ps = items.map(byId);
    const avg = ps.reduce((s, p) => s + p.formality, 0) / (ps.length || 1);
    const occ = SECTION_OCC[o.section] || (avg <= 2.4 ? 'quotidien' : avg <= 3.6 ? 'sortie' : 'soiree');
    return { id, title: o.title, items, occasion: occ, tip: (o.tip || '').replace(/^\p{Extended_Pictographic}\s*/u, ''), favorite: false, source: 'style-fred', order };
  };
  const outfits = [];
  (data.TENUES || []).forEach((o, i) => { const id = 'sf-t' + (o.num ?? i); if (!existingO.has(id)) outfits.push(mkOutfit(o, id, i)); });
  (data.EXTRA || []).forEach((o, i) => { const id = 'sf-x' + i; if (!existingO.has(id)) outfits.push(mkOutfit(o, id, 500 + i)); });
  await DB.putMany('outfits', outfits.filter(o => o.items.length >= 2));
  await loadAll();
  return { pieces: pieces.length, outfits: outfits.length };
}

/* ---------- photos ---------- */
function compressPhoto(file, maxH = 1100) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxH / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', .82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Photo illisible.')); };
    img.src = url;
  });
}

/* ---------- interface : utilitaires ---------- */
const $app = document.getElementById('app');
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2400);
}
function sheet(html) {
  const s = document.getElementById('sheet');
  if (!html) { s.hidden = true; s.innerHTML = ''; return; }
  s.innerHTML = `<div class="panel">${html}</div>`; s.hidden = false;
}
function confirmSheet(text, okLabel, onOk) {
  sheet(`<h2>${esc(text)}</h2><div class="row"><button class="btn alt" data-act="sheet-close">Annuler</button><button class="btn danger" data-act="sheet-ok">${esc(okLabel)}</button></div>`);
  confirmSheet.ok = onOk;
}
function go(view, param = null) { S.view = view; S.param = param; render(); window.scrollTo(0, 0); }
const chip = (label, on, act, extra = '') => `<button class="chip${on ? ' on' : ''}" data-act="${act}" ${extra}>${esc(label)}</button>`;
const piecesLine = ids => `<div class="pieces-line">${ids.map(byId).filter(Boolean).map(p => `<span>${esc(p.label)}</span>`).join('')}</div>`;
const colorName = c => COLORS[c]?.[0] || c;

/* ---------- écrans ---------- */
const VIEWS = {
  welcome() {
    return `<div class="welcome">
      <h1>Penderie</h1>
      <p>Ton dressing dans la poche. Pour démarrer, importe ta page « Style · Fred » : pièces, photos et tenues sont reprises d'un coup.</p>
      <button class="btn main" data-act="pick-stylefred">Importer ma page Style · Fred</button>
      <button class="btn alt" data-act="pick-backup">Restaurer une sauvegarde</button>
      <button class="btn small alt" data-act="start-empty">Commencer avec un dressing vide</button>
    </div>`;
  },

  today() {
    if (!S.pieces.length) return VIEWS.welcome();
    const t = S.today;
    const ids = slotsToIds(t.slots);
    const d = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const wornToday = S.worn.some(w => w.date === todayStr());
    return `<div class="top"><div><h1>Aujourd'hui</h1><div class="sub">${esc(d)}</div></div></div>
      <div class="chips">${OCCS.map(([k, l]) => chip(l, t.occ === k, 'today-occ', `data-occ="${k}"`)).join('')}</div>
      <div class="card">
        <div class="sil-wrap">${silCanvas(ids, 280)}</div>
        ${piecesLine(ids)}
      </div>
      <button class="btn main" data-act="wear-today">${wornToday ? 'Portée aujourd’hui ✓' : 'Je la porte'}</button>
      <div class="row"><button class="btn alt" data-act="today-reroll">Autre tenue</button><button class="btn alt" data-act="today-edit">Modifier</button></div>`;
  },

  dressing() {
    const term = S.dressSearch.trim().toLowerCase();
    const list = S.pieces.filter(p => (S.dressCat === 'all' || p.category === S.dressCat) && (!term || (p.label + ' ' + colorName(p.color)).toLowerCase().includes(term)));
    return `<div class="top"><div><h1>Dressing</h1><div class="sub">${S.pieces.length} pièces</div></div></div>
      <input class="search" id="dress-search" type="search" placeholder="Rechercher : nom, couleur…" value="${esc(S.dressSearch)}">
      <div class="chips">${chip('Tout', S.dressCat === 'all', 'dress-cat', 'data-cat="all"')}${CATS.map(([k, l]) => chip(l, S.dressCat === k, 'dress-cat', `data-cat="${k}"`)).join('')}</div>
      ${list.length ? `<div class="grid">${list.map(p => `<button class="tile pos-${CAT_POS[p.category]}" data-act="open-piece" data-id="${esc(p.id)}"><img src="${p.photo}" alt="" loading="lazy"><span class="tag">${esc(p.label)}</span></button>`).join('')}</div>` : `<div class="empty">Aucune pièce ne correspond.</div>`}
      <button class="fab" data-act="add-piece" aria-label="Ajouter un vêtement">+</button>`;
  },

  piece() {
    const p = byId(S.param);
    if (!p) return VIEWS.dressing();
    const uses = S.outfits.filter(o => o.items.includes(p.id)).length;
    const cpw = p.price && p.wornCount ? (p.price / p.wornCount).toFixed(2).replace('.', ',') + ' €' : '—';
    const canCalib = ['haut', 'veste', 'bas'].includes(p.category);
    return `<button class="back" data-act="go" data-view="dressing">‹ Dressing</button>
      <div class="photo-big"><img src="${p.photo}" alt="${esc(p.label)}"></div>
      <div class="label">
        <div><span>Nom</span><input type="text" id="pf-label" value="${esc(p.label)}"></div>
        <div><span>Catégorie</span><select id="pf-category">${CATS.map(([k]) => `<option value="${k}"${p.category === k ? ' selected' : ''}>${CAT_ONE[k]}</option>`).join('')}</select></div>
        <div><span>Couleur</span><select id="pf-color">${Object.entries(COLORS).map(([k, [l]]) => `<option value="${k}"${p.color === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><span>Habillé</span><div class="seg">${[1, 2, 3, 4, 5].map(n => `<button class="${p.formality === n ? 'on' : ''}" data-act="pf-formality" data-n="${n}" title="${FORMALITY[n]}">${n}</button>`).join('')}</div></div>
        <div><span>Occasions</span><div class="checks">${OCCS.map(([k, l]) => `<label><input type="checkbox" data-act="pf-occ" value="${k}"${(p.occasions || []).includes(k) ? ' checked' : ''}>${l}</label>`).join('')}</div></div>
        <div><span>Prix</span><input type="text" id="pf-price" inputmode="decimal" placeholder="facultatif" value="${p.price ? String(p.price).replace('.', ',') : ''}"></div>
        <div><span>Portée</span><span>${p.wornCount || 0} fois${p.lastWorn ? ' · dernière ' + new Date(p.lastWorn).toLocaleDateString('fr-FR') : ''}</span></div>
        <div><span>Coût par port</span><span>${cpw}</span></div>
        <div><span>Tenues</span><span>${uses}</span></div>
      </div>
      ${canCalib ? `<button class="btn thread" data-act="open-calib" data-id="${esc(p.id)}">Régler la silhouette</button>` : ''}
      <button class="btn alt" data-act="build-with" data-id="${esc(p.id)}">Créer une tenue avec cette pièce</button>
      <button class="btn danger" data-act="del-piece" data-id="${esc(p.id)}">Supprimer la pièce</button>`;
  },

  calib() {
    const p = byId(S.param);
    const c = S.calibDraft;
    const isBot = p.category === 'bas';
    const sl = (key, label, min, max) => `<label class="slider">${label}<input type="range" min="${min}" max="${max}" step="0.005" value="${c[key]}" data-act="calib-slide" data-key="${key}"></label>`;
    return `<button class="back" data-act="open-piece" data-id="${esc(p.id)}">‹ ${esc(p.label)}</button>
      <h2>Régler la silhouette</h2>
      <p class="sub">${isBot ? 'Place la ligne moutarde sur la ceinture, les deux traits sur les côtés des hanches, et la ligne grise aux chevilles.' : 'Place la ligne moutarde là où la pièce s’arrête (bas de la chemise ou de la veste) et les deux traits sur les côtés des hanches.'}</p>
      <div class="calib">
        <canvas id="calib-photo"></canvas>
        <div class="sil-wrap"><canvas id="calib-preview"></canvas></div>
      </div>
      <div class="card">
        ${sl('cut', isBot ? 'Ceinture' : 'Bas de la pièce', .1, .8)}
        ${sl('l', 'Hanche gauche', 0, .6)}
        ${sl('r', 'Hanche droite', .4, 1)}
        ${isBot ? sl('ankle', 'Chevilles', .6, 1) : ''}
      </div>
      <div class="row"><button class="btn alt" data-act="calib-reset">Valeurs par défaut</button><button class="btn main" data-act="calib-save">Enregistrer</button></div>`;
  },

  outfits() {
    const list = S.outfits.filter(o => S.outfitOcc === 'all' || o.occasion === S.outfitOcc);
    return `<div class="top"><div><h1>Tenues</h1><div class="sub">${S.outfits.length} tenues enregistrées</div></div><button class="btn small thread" data-act="new-outfit">Créer</button></div>
      <div class="chips">${chip('Toutes', S.outfitOcc === 'all', 'outfit-occ', 'data-occ="all"')}${OCCS.map(([k, l]) => chip(l, S.outfitOcc === k, 'outfit-occ', `data-occ="${k}"`)).join('')}${chip('Favorites', S.outfitOcc === 'fav', 'outfit-occ', 'data-occ="fav"')}</div>
      ${(S.outfitOcc === 'fav' ? S.outfits.filter(o => o.favorite) : list).length ? `<div class="olist">${(S.outfitOcc === 'fav' ? S.outfits.filter(o => o.favorite) : list).map(o => `<button class="ocard" data-act="open-outfit" data-id="${esc(o.id)}">
        <div class="sil-wrap">${silCanvas(o.items, 150)}</div>
        <span class="badge">${esc(OCC_LABEL[o.occasion] || '')}${o.favorite ? ' · ★' : ''}</span><b>${esc(o.title)}</b></button>`).join('')}</div>` : '<div class="empty">Aucune tenue ici pour l’instant.</div>'}`;
  },

  outfit() {
    const o = S.outfits.find(x => x.id === S.param);
    if (!o) return VIEWS.outfits();
    return `<button class="back" data-act="go" data-view="outfits">‹ Tenues</button>
      <div class="top"><h2>${esc(o.title)}</h2><button class="btn small alt" data-act="fav-outfit" data-id="${esc(o.id)}">${o.favorite ? '★ Favorite' : '☆ Favorite'}</button></div>
      <span class="badge">${esc(OCC_LABEL[o.occasion] || '')}</span>
      <div class="sil-wrap">${silCanvas(o.items, 300)}</div>
      ${piecesLine(o.items)}
      ${o.tip ? `<p class="tip">${esc(o.tip)}</p>` : ''}
      <button class="btn main" data-act="wear-outfit" data-id="${esc(o.id)}">Je la porte aujourd'hui</button>
      <div class="row"><button class="btn alt" data-act="edit-outfit" data-id="${esc(o.id)}">Modifier</button><button class="btn danger" data-act="del-outfit" data-id="${esc(o.id)}">Supprimer</button></div>`;
  },

  builder() {
    const d = S.draft;
    const ids = slotsToIds(d.slots);
    const slotRow = slot => {
      const p = d.slots[slot] ? byId(d.slots[slot]) : null;
      const optional = slot === 'veste' || slot === 'accessoire';
      return `<div class="slot">
        <button class="arrow" data-act="slot-prev" data-slot="${slot}" aria-label="Précédent">‹</button>
        <div class="mid${d.locked[slot] ? ' locked' : ''}">
          <div class="thumb pos-${CAT_POS[slot]}">${p ? `<img src="${p.photo}" alt="">` : ''}</div>
          <div class="name"><small>${CAT_ONE[slot]}${optional ? ' · facultatif' : ''}</small><b>${p ? esc(p.label) : 'Aucun'}</b></div>
          <button class="lock${d.locked[slot] ? ' on' : ''}" data-act="slot-lock" data-slot="${slot}">${d.locked[slot] ? 'Verrouillé' : 'Verrouiller'}</button>
        </div>
        <button class="arrow" data-act="slot-next" data-slot="${slot}" aria-label="Suivant">›</button>
      </div>`;
    };
    return `<button class="back" data-act="builder-cancel">‹ Annuler</button>
      <h1>${d.editId ? 'Modifier la tenue' : 'Nouvelle tenue'}</h1>
      <div class="chips">${OCCS.map(([k, l]) => chip(l, d.occ === k, 'builder-occ', `data-occ="${k}"`)).join('')}</div>
      <div class="sil-wrap">${silCanvas(ids, 240)}</div>
      <div class="stack">${SLOTS.map(slotRow).join('')}</div>
      <button class="btn alt" data-act="builder-roll">Tirer au sort (hors pièces verrouillées)</button>
      <input class="field" id="builder-title" placeholder="Nom de la tenue (facultatif)" value="${esc(d.title || '')}">
      <button class="btn thread" data-act="builder-save">Enregistrer la tenue</button>
      ${d.fromToday ? '<button class="btn main" data-act="builder-today">Utiliser comme tenue du jour</button>' : ''}`;
  },

  settings() {
    const month = todayStr().slice(0, 7);
    const wornMonth = new Set(S.worn.filter(w => w.date.startsWith(month)).flatMap(w => w.items)).size;
    const never = S.pieces.filter(p => !p.wornCount).length;
    return `<h1>Réglages</h1>
      <div class="card"><div class="stat-row"><div><b>${S.pieces.length}</b><small>pièces</small></div><div><b>${wornMonth}</b><small>portées ce mois</small></div><div><b>${never}</b><small>jamais portées</small></div></div></div>
      <div class="card"><h2>Sauvegarde</h2><p class="sub">Tout est sur ce téléphone. Exporte une sauvegarde de temps en temps et range-la sur ton Drive.</p>
        <button class="btn main" data-act="export">Exporter une sauvegarde</button>
        <button class="btn alt" data-act="pick-backup">Restaurer une sauvegarde</button></div>
      <div class="card"><h2>Import</h2><p class="sub">Ajoute les pièces et tenues de « Style · Fred » qui ne sont pas encore là. Rien n'est écrasé.</p>
        <button class="btn alt" data-act="pick-stylefred">Importer ma page Style · Fred</button></div>
      <div class="card"><h2>Tout effacer</h2><p class="sub">Supprime pièces, tenues et historique de ce téléphone.</p>
        <button class="btn danger" data-act="wipe">Tout effacer</button></div>
      <p class="sub">Penderie · version 1 · hors ligne</p>`;
  },
};

function render() {
  if (S.view === 'today' && S.pieces.length && (!S.today || S.today.date !== todayStr())) {
    const occ = S.today?.occ || 'quotidien';
    S.today = { date: todayStr(), occ, slots: generate(occ) };
    DB.setKV('today', S.today);
  }
  const html = (VIEWS[S.view] || VIEWS.today)();
  $app.innerHTML = html;
  const nav = document.getElementById('nav');
  nav.hidden = !S.pieces.length && S.view !== 'settings';
  const navView = { piece: 'dressing', calib: 'dressing', outfit: 'outfits', builder: 'outfits' }[S.view] || S.view;
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === navView));
  drawAll();
  if (S.view === 'calib') drawCalib();
}

/* ---------- réglage silhouette ---------- */
async function drawCalib() {
  const p = byId(S.param), c = S.calibDraft;
  const img = await imgOf(p);
  const cv = document.getElementById('calib-photo');
  if (!cv || !img) return;
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  const lw = Math.max(2, img.width / 140);
  g.lineWidth = lw;
  g.strokeStyle = '#C8901A';
  g.beginPath(); g.moveTo(0, c.cut * img.height); g.lineTo(img.width, c.cut * img.height); g.stroke();
  g.strokeStyle = '#2B3A67';
  [c.l, c.r].forEach(x => { g.beginPath(); g.moveTo(x * img.width, (c.cut - .08) * img.height); g.lineTo(x * img.width, (c.cut + .08) * img.height); g.stroke(); });
  if (c.ankle != null) { g.strokeStyle = '#9A9DA3'; g.setLineDash([lw * 3, lw * 2]); g.beginPath(); g.moveTo(0, c.ankle * img.height); g.lineTo(img.width, c.ankle * img.height); g.stroke(); g.setLineDash([]); }
  const partnerCat = p.category === 'bas' ? 'haut' : 'bas';
  const partner = S.pieces.find(x => x.category === partnerCat);
  const slots = { [p.category]: p.id };
  if (partner) slots[partnerCat] = partner.id;
  const shoe = S.pieces.find(x => x.category === 'chaussure');
  if (shoe) slots.chaussure = shoe.id;
  const pv = document.getElementById('calib-preview');
  const box = pv.parentElement.clientWidth - 20;
  drawSilhouette(pv, slots, Math.max(120, Math.min(220, box)), { [p.id]: c });
}

/* ---------- actions ---------- */
async function saveToday() { await DB.setKV('today', S.today); }
async function wear(ids) {
  const date = todayStr();
  if (S.worn.some(w => w.date === date)) { toast('Une tenue est déjà notée pour aujourd’hui.'); return; }
  const w = { id: uid('w'), date, items: ids };
  await DB.put('worn', w);
  const now = Date.now();
  const changed = ids.map(byId).filter(Boolean).map(p => ({ ...p, wornCount: (p.wornCount || 0) + 1, lastWorn: now }));
  await DB.putMany('pieces', changed);
  await loadAll();
  toast('Notée. Bonne journée !');
  render();
}
async function savePieceField(id, patch) {
  const p = byId(id);
  if (!p) return;
  Object.assign(p, patch);
  await DB.put('pieces', p);
}
function cycle(slot, dir) {
  const d = S.draft;
  const list = S.pieces.filter(p => p.category === slot);
  const optional = slot === 'veste' || slot === 'accessoire';
  const ids = (optional ? [null] : []).concat(list.map(p => p.id));
  if (!ids.length) return;
  let i = ids.indexOf(d.slots[slot] ?? null);
  i = (i + dir + ids.length) % ids.length;
  if (ids[i]) d.slots[slot] = ids[i]; else delete d.slots[slot];
  render();
}
function openBuilder(slots, opts = {}) {
  S.draft = { slots: { ...slots }, locked: {}, occ: opts.occ || S.today?.occ || 'quotidien', title: opts.title || '', editId: opts.editId || null, fromToday: !!opts.fromToday };
  go('builder');
}
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function readFile(input) {
  return new Promise(res => {
    input.value = '';
    input.onchange = () => res(input.files[0] || null);
    input.click();
  });
}

const ACTIONS = {
  go: el => go(el.dataset.view),
  'start-empty': async () => { S.view = 'dressing'; render(); S.pieces.length || addPieceSheet(); },
  'pick-stylefred': async () => {
    const f = await readFile(document.getElementById('file-stylefred'));
    if (!f) return;
    try {
      const r = await importStyleFred(await f.text());
      toast(`Import terminé : ${r.pieces} pièces, ${r.outfits} tenues.`);
      go('today');
    } catch (e) { toast(e.message || 'Import impossible.'); }
  },
  'pick-backup': async () => {
    const f = await readFile(document.getElementById('file-backup'));
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'penderie') throw new Error('Ce fichier n’est pas une sauvegarde Penderie.');
      await Promise.all(['pieces', 'outfits', 'worn'].map(s => DB.clear(s)));
      await DB.putMany('pieces', data.pieces || []);
      await DB.putMany('outfits', data.outfits || []);
      await DB.putMany('worn', data.worn || []);
      imgCache.clear();
      await loadAll();
      toast('Sauvegarde restaurée.');
      go('today');
    } catch (e) { toast(e.message || 'Sauvegarde illisible.'); }
  },
  export: () => {
    download(`penderie-sauvegarde-${todayStr()}.json`, JSON.stringify({ app: 'penderie', version: 1, exportedAt: new Date().toISOString(), pieces: S.pieces, outfits: S.outfits, worn: S.worn }));
    toast('Sauvegarde exportée dans tes téléchargements.');
  },
  wipe: () => confirmSheet('Tout effacer de ce téléphone ?', 'Tout effacer', async () => {
    await Promise.all(['pieces', 'outfits', 'worn', 'kv'].map(s => DB.clear(s)));
    imgCache.clear(); S.today = null;
    await loadAll(); go('today');
  }),
  'sheet-close': () => sheet(null),
  'sheet-ok': async () => { const f = confirmSheet.ok; sheet(null); if (f) await f(); },

  'today-occ': async el => { S.today = { date: todayStr(), occ: el.dataset.occ, slots: generate(el.dataset.occ) }; await saveToday(); render(); },
  'today-reroll': async () => { S.today.slots = generate(S.today.occ); await saveToday(); render(); },
  'today-edit': () => openBuilder(S.today.slots, { occ: S.today.occ, fromToday: true }),
  'wear-today': () => wear(slotsToIds(S.today.slots)),

  'dress-cat': el => { S.dressCat = el.dataset.cat; render(); },
  'open-piece': el => go('piece', el.dataset.id),
  'pf-formality': async el => { await savePieceField(S.param, { formality: +el.dataset.n }); render(); },
  'pf-occ': async () => {
    const occs = [...document.querySelectorAll('[data-act="pf-occ"]:checked')].map(i => i.value);
    await savePieceField(S.param, { occasions: occs });
  },
  'build-with': el => { const p = byId(el.dataset.id); openBuilder({ [p.category]: p.id }); S.draft.locked[p.category] = true; render(); },
  'del-piece': el => confirmSheet('Supprimer cette pièce ?', 'Supprimer', async () => {
    const id = el.dataset.id;
    await DB.del('pieces', id);
    const touched = S.outfits.filter(o => o.items.includes(id)).map(o => ({ ...o, items: o.items.filter(i => i !== id) }));
    await DB.putMany('outfits', touched);
    await loadAll();
    toast('Pièce supprimée.');
    go('dressing');
  }),
  'add-piece': () => addPieceSheet(),

  'open-calib': el => { const p = byId(el.dataset.id); S.calibDraft = calibOf(p); go('calib', p.id); },
  'calib-reset': () => { const p = byId(S.param); S.calibDraft = calibOf({ ...p, calib: null }); render(); },
  'calib-save': async () => { await savePieceField(S.param, { calib: { ...S.calibDraft } }); toast('Silhouette réglée.'); go('piece', S.param); },

  'outfit-occ': el => { S.outfitOcc = el.dataset.occ; render(); },
  'open-outfit': el => go('outfit', el.dataset.id),
  'fav-outfit': async el => { const o = S.outfits.find(x => x.id === el.dataset.id); o.favorite = !o.favorite; await DB.put('outfits', o); render(); },
  'wear-outfit': async el => {
    const o = S.outfits.find(x => x.id === el.dataset.id);
    S.today = { date: todayStr(), occ: o.occasion, slots: itemsToSlots(o.items) };
    await saveToday();
    await wear(o.items);
  },
  'edit-outfit': el => { const o = S.outfits.find(x => x.id === el.dataset.id); openBuilder(itemsToSlots(o.items), { occ: o.occasion, title: o.title, editId: o.id }); },
  'del-outfit': el => confirmSheet('Supprimer cette tenue ?', 'Supprimer', async () => { await DB.del('outfits', el.dataset.id); await loadAll(); toast('Tenue supprimée.'); go('outfits'); }),
  'new-outfit': () => openBuilder(generate(S.outfitOcc in OCC_LABEL ? S.outfitOcc : 'quotidien'), { occ: S.outfitOcc in OCC_LABEL ? S.outfitOcc : 'quotidien' }),

  'slot-prev': el => cycle(el.dataset.slot, -1),
  'slot-next': el => cycle(el.dataset.slot, 1),
  'slot-lock': el => { const s = el.dataset.slot; S.draft.locked[s] = !S.draft.locked[s]; render(); },
  'builder-occ': el => { S.draft.occ = el.dataset.occ; render(); },
  'builder-roll': () => {
    const d = S.draft;
    const locked = Object.fromEntries(Object.keys(d.locked).filter(k => d.locked[k] && d.slots[k]).map(k => [k, d.slots[k]]));
    d.slots = generate(d.occ, locked);
    render();
  },
  'builder-cancel': () => go(S.draft?.fromToday ? 'today' : S.draft?.editId ? 'outfit' : 'outfits', S.draft?.editId),
  'builder-save': async () => {
    const d = S.draft;
    const items = slotsToIds(d.slots);
    if (items.length < 2) { toast('Choisis au moins deux pièces.'); return; }
    const title = d.title.trim() || items.map(byId).filter(p => p.category !== 'chaussure' && p.category !== 'accessoire').map(p => p.label).join(' + ');
    const old = d.editId ? S.outfits.find(o => o.id === d.editId) : null;
    const o = { ...(old || { id: uid('o'), favorite: false, source: 'penderie', tip: '' }), title, items, occasion: d.occ };
    await DB.put('outfits', o);
    await loadAll();
    toast('Tenue enregistrée.');
    go('outfit', o.id);
  },
  'builder-today': async () => {
    S.today = { date: todayStr(), occ: S.draft.occ, slots: { ...S.draft.slots } };
    await saveToday();
    go('today');
  },
};

/* ---------- ajout d'une pièce ---------- */
async function addPieceSheet() {
  const f = await readFile(document.getElementById('file-photo'));
  if (!f) return;
  let photo;
  try { photo = await compressPhoto(f); } catch (e) { toast(e.message); return; }
  S.addDraft = { photo, category: 'haut', color: 'blanc', formality: 3 };
  renderAddSheet();
}
function renderAddSheet() {
  const a = S.addDraft;
  sheet(`<h2>Nouvelle pièce</h2>
    <div class="row"><div class="photo-big" style="max-height:30vh"><img src="${a.photo}" alt="" style="max-height:30vh"></div>
    <div class="stack">
      <input class="field" id="add-label" placeholder="Nom (ex. Chemise lin blanche)" value="${esc(a.label || '')}">
      <select class="field" id="add-category">${CATS.map(([k]) => `<option value="${k}"${a.category === k ? ' selected' : ''}>${CAT_ONE[k]}</option>`).join('')}</select>
      <select class="field" id="add-color">${Object.entries(COLORS).map(([k, [l]]) => `<option value="${k}"${a.color === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    </div></div>
    <div><div class="sub">Niveau d'habillé : ${FORMALITY[a.formality]}</div><div class="seg">${[1, 2, 3, 4, 5].map(n => `<button class="${a.formality === n ? 'on' : ''}" data-act-add="formality" data-n="${n}">${n}</button>`).join('')}</div></div>
    <div class="row"><button class="btn alt" data-act="sheet-close">Annuler</button><button class="btn thread" data-act-add="save">Ajouter</button></div>`);
}
document.getElementById('sheet').addEventListener('click', async e => {
  if (e.target.id === 'sheet') { sheet(null); return; }
  const el = e.target.closest('[data-act-add]');
  if (!el) return;
  const a = S.addDraft;
  a.label = document.getElementById('add-label').value;
  a.category = document.getElementById('add-category').value;
  a.color = document.getElementById('add-color').value;
  if (el.dataset.actAdd === 'formality') { a.formality = +el.dataset.n; renderAddSheet(); return; }
  if (!a.label.trim()) { toast('Donne un nom à la pièce.'); return; }
  const p = {
    id: uid('p'), label: a.label.trim(), category: a.category, color: a.color, formality: a.formality,
    occasions: occFromFormality(a.formality), photo: a.photo, photoV: 1, calib: null,
    wornCount: 0, lastWorn: null, state: 'bon', source: 'penderie', createdAt: Date.now(),
  };
  await DB.put('pieces', p);
  await loadAll();
  sheet(null);
  toast('Pièce ajoutée.');
  if (['haut', 'veste', 'bas'].includes(p.category)) { S.calibDraft = calibOf(p); go('calib', p.id); } else go('piece', p.id);
});

/* ---------- événements ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.type === 'checkbox') return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.act === 'pf-occ') ACTIONS['pf-occ']();
  if (t.id === 'pf-category') savePieceField(S.param, { category: t.value }).then(render);
  if (t.id === 'pf-color') savePieceField(S.param, { color: t.value });
  if (t.id === 'pf-label' && t.value.trim()) savePieceField(S.param, { label: t.value.trim() }).then(loadAll);
  if (t.id === 'pf-price') { const v = parseFloat(t.value.replace(',', '.')); savePieceField(S.param, { price: isFinite(v) && v > 0 ? v : null }).then(render); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'dress-search') {
    S.dressSearch = t.value;
    const pos = t.selectionStart;
    render();
    const n = document.getElementById('dress-search');
    n.focus(); n.setSelectionRange(pos, pos);
  }
  if (t.id === 'builder-title') S.draft.title = t.value;
  if (t.dataset.act === 'calib-slide') { S.calibDraft[t.dataset.key] = +t.value; drawCalib(); }
});

/* ---------- démarrage ---------- */
(async () => {
  try {
    await DB.open();
    await loadAll();
  } catch (e) {
    $app.innerHTML = '<div class="empty">Le stockage du téléphone est indisponible (navigation privée ?). Penderie a besoin de lui pour garder ton dressing.</div>';
    return;
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

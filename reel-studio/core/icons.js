// Resolve simple English nouns to icons in the local library (hand → health → tabler).

const ALIASES = {
  heart: 'hand:heart', cardio: 'hand:heart', love: 'hand:heart', lung: 'hand:lungs', breath: 'hand:lungs', breathing: 'hand:lungs',
  oxygen: 'hand:molecule', co2: 'hand:molecule', 'carbon-dioxide': 'hand:molecule', gene: 'hand:dna', genes: 'hand:dna', helix: 'hand:dna',
  blood: 'hand:blood-drop', 'blood-cell': 'hand:red-cell', 'red-blood-cell': 'hand:red-cell', hemoglobin: 'hand:red-cell',
  germ: 'hand:bacteria', microbe: 'hand:bacteria', nerve: 'hand:neuron', synapse: 'hand:neuron', electricity: 'hand:bolt', lightning: 'hand:bolt',
  energy: 'hand:bolt', power: 'hand:bolt', fire: 'hand:flame', heat: 'hand:flame', water: 'hand:drop', liquid: 'hand:drop', sweat: 'hand:drop',
  ice: 'hand:snowflake', cold: 'hand:snowflake', plant: 'hand:leaf', photosynthesis: 'hand:leaf', time: 'hand:clock', hour: 'hand:clock',
  temperature: 'hand:thermometer', fever: 'hand:thermometer', chemistry: 'hand:flask', experiment: 'hand:flask', lab: 'hand:microscope',
  zoom: 'hand:magnifier', search: 'hand:magnifier', meal: 'hand:food', eat: 'hand:food', glucose: 'hand:sugar', caffeine: 'hand:coffee', tea: 'hand:coffee',
  noise: 'hand:sound', music: 'hand:sound', voice: 'hand:sound', mobile: 'hand:phone', smartphone: 'hand:phone', machine: 'hand:gear',
  danger: 'hand:warning', alert: 'hand:warning', why: 'hand:question', bulb: 'hand:idea', human: 'hand:person', population: 'hand:people',
  data: 'hand:chart', graph: 'hand:chart', balance: 'hand:scale', vaccine: 'hand:syringe', medicine: 'hand:pill', drug: 'hand:pill',
  immunity: 'hand:shield', immune: 'hand:shield', antibody: 'hand:shield', air: 'hand:wind', ai: 'hand:robot', computer: 'hand:chip', internet: 'hand:wifi',
  photon: 'hand:light', ray: 'hand:light', optics: 'hand:lens', hearing: 'hand:ear', touch: 'hand:hand', star: 'hand:spark', fact: 'hand:spark',
  space: 'hand:planet', universe: 'hand:planet', world: 'hand:earth', globe: 'hand:globe', metro: 'hand:train', subway: 'hand:train',
  kidney: 'health:kidneys', kidneys: 'health:kidneys', liver: 'health:liver', intestine: 'health:intestine', intestines: 'health:intestine', gut: 'health:intestine',
  skeleton: 'hand:bone', calcium: 'hand:bone', skin: 'health:skin-layers', mitochondria: 'hand:cell', mitochondrion: 'hand:cell', nucleus: 'hand:cell', protein: 'hand:molecule', enzyme: 'hand:molecule', dopamine: 'hand:molecule', hormone: 'hand:molecule', bee: 'tabler:bug', insect: 'tabler:bug', stomach: 'hand:stomach', brain: 'hand:brain', mind: 'hand:brain',
};

function norm(noun) {
  let s = String(noun || '').toLowerCase().trim().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
  return s;
}
function singular(s) {
  if (s.endsWith('ies') && s.length > 4) return s.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) return s.slice(0, -1);
  return s;
}

const SET_ORDER = ['hand', 'health', 'tabler'];

/** Build lookup indices once per library. */
export function indexLibrary(lib) {
  if (lib._idx) return lib._idx;
  const byName = new Map(), byTag = new Map();
  for (const key of Object.keys(lib.icons)) {
    const [set, name] = key.split(':');
    const add = (m, k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(key); };
    add(byName, name);
    add(byName, singular(name));
    for (const t of lib.icons[key].t || []) { add(byTag, norm(t)); add(byTag, singular(norm(t))); }
  }
  const rank = key => SET_ORDER.indexOf(key.split(':')[0]);
  for (const m of [byName, byTag]) for (const arr of m.values()) arr.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  Object.defineProperty(lib, '_idx', { value: { byName, byTag }, enumerable: false });
  return lib._idx;
}

/** Returns an icon key such as "hand:heart" (never null — falls back to a spark). */
export function resolveIcon(lib, noun) {
  const { byName, byTag } = indexLibrary(lib);
  const raw = String(noun || '').toLowerCase().trim();
  if (lib.icons[raw]) return raw; // already a key such as "health:nose"
  const n = norm(noun);
  if (!n) return 'hand:spark';
  const cands = [n, singular(n)];
  for (const c of cands) if (ALIASES[c] && lib.icons[ALIASES[c]]) return ALIASES[c];
  for (const c of cands) if (byName.has(c)) return byName.get(c)[0];
  for (const c of cands) if (byTag.has(c)) return byTag.get(c)[0];
  // multi-word: try each word, last word first ("red blood cell" → cell)
  const parts = n.split('-').filter(Boolean).reverse();
  if (parts.length > 1) for (const p of parts) { const k = resolveIcon(lib, p); if (k !== 'hand:spark') return k; }
  // partial name match
  for (const set of SET_ORDER) {
    const hit = Object.keys(lib.icons).find(k => k.startsWith(set + ':') && k.split(':')[1].includes(singular(n)) && singular(n).length >= 4);
    if (hit) return hit;
  }
  return 'hand:spark';
}

/** Resolve every icon noun in a storyboard; returns {map noun→key, icons subset, misses}. */
export function resolveStoryboardIcons(lib, storyboard) {
  const nouns = new Set();
  for (const s of storyboard.scenes) {
    if (s.icon) nouns.add(s.icon);
    for (const it of s.items) if (it.icon) nouns.add(it.icon);
  }
  const map = {}, icons = {}, misses = [];
  for (const noun of nouns) {
    const key = resolveIcon(lib, noun);
    map[noun] = key;
    if (key === 'hand:spark' && noun !== 'spark') misses.push(noun);
  }
  // keys the renderer always needs
  const always = ['hand:spark', 'hand:check', 'hand:question', 'hand:arrow', 'hand:person'];
  for (const key of [...Object.values(map), ...always]) if (lib.icons[key]) icons[key] = { v: lib.icons[key].v, m: lib.icons[key].m, d: lib.icons[key].d };
  // organ icons for the body template
  for (const s of storyboard.scenes) if (s.template === 'body') {
    const k = resolveIcon(lib, ORGAN_ICON[s.organ] || s.organ);
    map['organ:' + s.organ] = k;
    icons[k] = { v: lib.icons[k].v, m: lib.icons[k].m, d: lib.icons[k].d };
  }
  return { map, icons, misses };
}

export const ORGAN_ICON = {
  brain: 'brain', eyes: 'eye', nose: 'health:nose', mouth: 'health:mouth', throat: 'health:ear-nose-throat', lungs: 'lungs', heart: 'health:heart-organ', stomach: 'stomach',
  liver: 'liver', kidneys: 'kidneys', intestines: 'intestines', bladder: 'health:bladder', muscles: 'muscle', bones: 'bone', skin: 'health:skin-layers', blood: 'red-cell', nerves: 'neuron',
};

export function licenseSummary(lib) {
  return Object.entries(lib.sets || {}).map(([k, s]) => ({ set: k, name: s.name, license: s.license, url: s.url, count: s.count }));
}

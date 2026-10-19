// Casa Yuffie dinner planner: random dinner picks and a combined grocery list.
// Shared by the app (loaded as a plain script) and scripts/send-reminders.mjs (imported in Node),
// so both pick dinners and count groceries the same way. Exposes globalThis.CasaPlanner.
(function () {
  // ---------- dates (YYYY-MM-DD strings; weeks start on Sunday) ----------
  const DAY = 86400000;
  const toMs = k => Date.parse(`${k}T00:00:00Z`);
  const fromMs = ms => new Date(ms).toISOString().slice(0, 10);
  const addDays = (k, n) => fromMs(toMs(k) + n * DAY);
  const weekday = k => new Date(toMs(k)).getUTCDay();          // 0 = Sunday
  const weekStart = k => addDays(k, -weekday(k));
  const weekDays = start => Array.from({ length: 7 }, (_, i) => addDays(start, i));

  // ---------- random picks ----------
  function shuffle(list, rand = Math.random) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Recipes the shuffle can choose from: in the rotation and with ingredients filled in.
  // Falls back to every recipe in the rotation if none have ingredients yet.
  function dinnerPool(recipes) {
    const rotation = recipes.filter(r => r.in_rotation !== false);
    const ready = rotation.filter(r => (r.ingredients || []).length);
    return ready.length ? ready : rotation;
  }

  // Pick `count` recipes. Prefers ones not already this week (taken) and not last week (avoid);
  // repeats only when the recipe box is too small to fill every night.
  function pickDinners(pool, count, { avoid = new Set(), taken = new Set(), rand = Math.random } = {}) {
    const mixed = shuffle(pool, rand);
    const fresh = mixed.filter(r => !taken.has(r.id) && !avoid.has(r.id));
    const recent = mixed.filter(r => !taken.has(r.id) && avoid.has(r.id));
    const picks = [...fresh, ...recent].slice(0, count);
    while (picks.length < count && mixed.length) picks.push(mixed[picks.length % mixed.length]);
    return picks;
  }

  // ---------- reading ingredient lines ----------
  const FRACTIONS = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅕': '1/5', '⅙': '1/6' };
  const UNIT_WORDS = {
    cup: ['cups', 'cup'], tbsp: ['tablespoons', 'tablespoon', 'tbsps', 'tbsp', 'tbs', 'tbl'], tsp: ['teaspoons', 'teaspoon', 'tsps', 'tsp'],
    pint: ['pints', 'pint', 'pt'], quart: ['quarts', 'quart', 'qt'], gallon: ['gallons', 'gallon'],
    lb: ['pounds', 'pound', 'lbs', 'lb'], oz: ['ounces', 'ounce', 'oz'], 'fl oz': [],
    g: ['grams', 'gram', 'g'], kg: ['kilograms', 'kilogram', 'kg'], ml: ['milliliters', 'millilitres', 'milliliter', 'millilitre', 'ml'], l: ['liters', 'litres', 'liter', 'litre'],
    clove: ['cloves', 'clove'], can: ['cans', 'can'], jar: ['jars', 'jar'], package: ['packages', 'package', 'pkg', 'pkgs', 'packet', 'packets'],
    bag: ['bags', 'bag'], box: ['boxes', 'box'], bunch: ['bunches', 'bunch'], head: ['heads', 'head'], sprig: ['sprigs', 'sprig'],
    stalk: ['stalks', 'stalk'], slice: ['slices', 'slice'], stick: ['sticks', 'stick'], pinch: ['pinches', 'pinch'], dash: ['dashes', 'dash'],
    piece: ['pieces', 'piece'], fillet: ['fillets', 'fillet']
  };
  const UNIT_OF = {};
  for (const [unit, words] of Object.entries(UNIT_WORDS)) for (const w of words) UNIT_OF[w] = unit;

  const NUM = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+`;
  const QTY_RE = new RegExp(`^(${NUM})(?:\\s*(?:-|–|to)\\s*(${NUM}))?\\s*`);
  function toNumber(s) {
    s = s.trim();
    let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
    m = s.match(/^(\d+)\/(\d+)$/);
    if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
    return Number(s);
  }

  // Words that describe prep, not what to buy, so "2 onions, chopped" and "1 diced onion" merge.
  const PREP = /\b(freshly|fresh|finely|roughly|coarsely|thinly|thickly|chopped|minced|diced|sliced|grated|shredded|peeled|seeded|cubed|crushed|melted|softened|beaten|trimmed|rinsed|drained|halved|quartered|julienned|large|medium|small|boneless|skinless|packed|lightly|heaping|level|cold|warm|hot|cooked|uncooked|extra[- ]virgin|plus more|or more|to taste|as needed|for serving|for garnish|optional|divided|about|approximately|of)\b/g;

  function singular(w) {
    if (/(ss|us|is)$/.test(w)) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/(oes|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function parseIngredient(line) {
    let s = String(line || '')
      .replace(/[½⅓⅔¼¾⅛⅜⅝⅞⅕⅙]/g, f => ` ${FRACTIONS[f]}`)
      .replace(/(\d)\s+(\d\/)/g, '$1 $2')
      .replace(/^[\s\-•*▢□]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return null;

    let qty = null;
    const q = s.match(QTY_RE);
    if (q) { qty = toNumber(q[2] || q[1]); s = s.slice(q[0].length); }   // a range buys the larger amount

    let size = '';
    const p = s.match(/^\(([^)]{1,30})\)\s*/);
    if (p) { size = p[1].trim(); s = s.slice(p[0].length); }

    let unit = '';
    const u = s.match(/^(fl\.?\s*oz|[a-zA-Z]+)\.?(?=\s|$)\s*/);
    if (u) {
      const word = u[1].toLowerCase().replace(/\s+/g, ' ');
      if (/^fl\.?\s*oz$/.test(word)) unit = 'fl oz';
      else if (UNIT_OF[word]) unit = UNIT_OF[word];
      if (unit) s = s.slice(u[0].length);
    }
    s = s.replace(/^of\s+/i, '');

    const name = s.toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/,|;|\s[-–]\s|\bfor\b/)[0]
      .replace(PREP, ' ')
      .replace(/[*.:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^(and|or|a|an)\s+/, '')
      .trim();
    if (!name) return null;
    let clean = name.replace(/\ball[- ]purpose\b\s*/, '').trim() || name;
    // Canned goods are their own item (canned tomatoes aren't fresh tomatoes).
    if (unit === 'can' && !/\bcanned\b/.test(clean)) clean = `canned ${clean}`;
    const key = clean.split(' ').map(singular).join(' ');
    return { qty: Number.isFinite(qty) && qty > 0 ? qty : null, unit, size, name: clean, key, line: String(line).trim() };
  }

  // ---------- aisles ----------
  const SKIP = /^(water|ice|ice cube|hot water|cold water|warm water|boiling water)$/;
  const STAPLE = /^((kosher |sea |table |fine )?salt|(ground |cracked )?(black )?pepper|salt and (black )?pepper|(olive|vegetable|canola|neutral|cooking) oil|oil|cooking spray|nonstick cooking spray)$/;
  const AISLES = [
    ['Frozen', /\bfrozen\b/],
    ['Pantry', /\b(canned|jarred|marinara|broth|stock|bouillon|paste|sauce|salsa|canned|can|soup|coconut milk|peanut butter|almond butter|vinegar|soy|tamari|honey|maple|syrup|ketchup|mustard|mayo|mayonnaise|sriracha|oil|flour|sugar|cornstarch|baking|yeast|vanilla|cocoa|chocolate chip|rice|pasta|spaghetti|penne|noodle|macaroni|orzo|couscous|quinoa|oat|lentil|chickpea|bean|breadcrumb|panko|cracker|nut|almond|walnut|pecan|cashew|peanut|sesame|raisin|dried|powder|flake|ground (cumin|cinnamon|ginger|coriander|nutmeg|turmeric|cardamom|cloves?)|cumin|paprika|oregano|chili|cayenne|cinnamon|nutmeg|turmeric|curry|garam masala|bay lea|italian seasoning|seasoning|spice|extract|wine|beer)\b/],
    ['Meat & seafood', /\b(chicken|beef|steak|pork|bacon|ham|sausage|chorizo|turkey|lamb|veal|prosciutto|pancetta|salami|pepperoni|shrimp|prawn|salmon|tuna|cod|tilapia|halibut|fish|scallop|crab|lobster|mussel|clam|anchov|tofu|tempeh|meat)/],
    ['Dairy & eggs', /\b(milk|cream|butter|cheese|parmesan|parmigiano|pecorino|mozzarella|cheddar|ricotta|feta|goat cheese|gruyere|yogurt|yoghurt|sour cream|creme fraiche|half-and-half|half and half|ghee|eggs?|egg yolks?|egg whites?)\b/],
    ['Bakery', /\b(bread|baguette|bun|roll|tortilla|pita|naan|bagel|croissant|english muffin|brioche|ciabatta|sourdough|flatbread|wrap)/],
    ['Produce', /\b(onion|shallot|scallion|leek|garlic|ginger|tomato|potato|yam|carrot|celery|bell pepper|jalape|serrano|poblano|chile|chili pepper|pepper|lettuce|romaine|spinach|kale|chard|arugula|cabbage|bok choy|broccoli|broccolini|cauliflower|zucchini|squash|pumpkin|eggplant|mushroom|cucumber|avocado|lemon|lime|orange|apple|pear|banana|berr|grape|mango|pineapple|peach|plum|cherr|melon|corn|pea|green bean|asparagus|beet|radish|turnip|parsnip|fennel|herb|cilantro|parsley|basil|mint|dill|thyme|rosemary|sage|chive|tarragon|sprout|salad|greens|edamame|jicama|okra|artichoke)/]
  ];
  const AISLE_ORDER = ['Produce', 'Meat & seafood', 'Dairy & eggs', 'Bakery', 'Pantry', 'Frozen', 'Other'];
  function aisleOf(key) {
    if (STAPLE.test(key)) return 'Staples';
    for (const [aisle, re] of AISLES) if (re.test(key)) return aisle;
    return 'Other';
  }

  // ---------- amounts ----------
  const US_VOLUME = { tsp: 1, tbsp: 3, cup: 48, 'fl oz': 6, pint: 96, quart: 192, gallon: 768 };
  const US_WEIGHT = { oz: 1, lb: 16 };
  const COUNTED = new Set(['clove', 'can', 'jar', 'package', 'bag', 'box', 'bunch', 'head', 'sprig', 'stalk', 'slice', 'stick', 'pinch', 'dash', 'piece', 'fillet', 'cup']);
  const VULGAR = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];
  function fmt(n) {
    let whole = Math.floor(n + 1e-9);
    const frac = n - whole;
    for (const [v, ch] of VULGAR) {
      if (Math.abs(frac - v) < 0.04) {
        if (v === 1) whole += 1;
        return `${whole || (ch ? '' : '0')}${ch}` || '0';
      }
    }
    return String(Math.round(n * 10) / 10);
  }
  const unitLabel = (unit, n) => !unit ? '' : (COUNTED.has(unit) && n > 1 + 1e-9 ? unit + (/(ch|sh|x)$/.test(unit) ? 'es' : 's') : unit);
  const amountText = (n, unit, size = '') => [fmt(n), unitLabel(unit, n), size && `(${size})`].filter(Boolean).join(' ');

  function volumeText(tsp) {
    if (tsp >= 12) {
      const cups = tsp / 48, quarters = Math.round(cups * 4) / 4, thirds = Math.round(cups * 3) / 3;
      return amountText(Math.abs(thirds - cups) < Math.abs(quarters - cups) ? thirds : quarters, 'cup');
    }
    if (tsp >= 3) return amountText(Math.round((tsp / 3) * 2) / 2, 'tbsp');
    return amountText(Math.round(tsp * 4) / 4, 'tsp');
  }

  // Sum one ingredient's amounts: US volumes together, US weights together, everything else by unit.
  function combineAmounts(parts) {
    const buckets = new Map();
    let unmeasured = false;
    for (const p of parts) {
      if (p.qty == null) { unmeasured = true; continue; }
      let bucket, value = p.qty;
      if (US_VOLUME[p.unit] && !p.size) { bucket = 'vol'; value *= US_VOLUME[p.unit]; }
      else if (US_WEIGHT[p.unit] && !p.size) { bucket = 'wt'; value *= US_WEIGHT[p.unit]; }
      else bucket = `${p.unit}|${p.size}`;
      buckets.set(bucket, (buckets.get(bucket) || 0) + value);
    }
    const out = [];
    for (const [bucket, total] of buckets) {
      if (bucket === 'vol') out.push(volumeText(total));
      else if (bucket === 'wt') out.push(total >= 16 ? amountText(Math.round((total / 16) * 4) / 4, 'lb') : amountText(Math.round(total * 4) / 4, 'oz'));
      else { const [unit, size] = bucket.split('|'); out.push(amountText(total, unit, size)); }
    }
    if (unmeasured && !out.length) return '';
    return out.join(' + ');
  }

  // Build the week's grocery list from the planned recipes (a recipe planned twice counts twice).
  // Returns [{ aisle, items: [{ key, name, amount, recipes: [titles], lines: [original lines] }] }].
  function groceryList(recipes) {
    const byKey = new Map();
    for (const r of recipes) {
      for (const line of r.ingredients || []) {
        const p = parseIngredient(line);
        if (!p || SKIP.test(p.key)) continue;
        const item = byKey.get(p.key) || { key: p.key, name: p.name, parts: [], recipes: [], lines: [] };
        item.parts.push(p);
        item.lines.push(p.line);
        if (!item.recipes.includes(r.title)) item.recipes.push(r.title);
        byKey.set(p.key, item);
      }
    }
    const groups = new Map();
    for (const item of byKey.values()) {
      let aisle = aisleOf(item.key);
      if (aisle !== 'Staples' && item.parts.some(p => p.unit === 'can' || p.unit === 'jar')) aisle = 'Pantry';
      const name = item.name.charAt(0).toUpperCase() + item.name.slice(1);
      (groups.get(aisle) || groups.set(aisle, []).get(aisle))
        .push({ key: item.key, name, amount: combineAmounts(item.parts), recipes: item.recipes, lines: item.lines });
    }
    return [...AISLE_ORDER, 'Staples']
      .filter(a => groups.has(a))
      .map(aisle => ({ aisle, items: groups.get(aisle).sort((a, b) => a.name.localeCompare(b.name)) }));
  }

  globalThis.CasaPlanner = {
    addDays, weekday, weekStart, weekDays, shuffle, dinnerPool, pickDinners, parseIngredient, aisleOf, combineAmounts, groceryList
  };
})();

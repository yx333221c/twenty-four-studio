/**
 * Twenty-Four Studio — core engine
 * --------------------------------
 * · Exact rational arithmetic (BigInt fractions): no float error, so
 *   5×(5−1÷5) is recognised as *exactly* 24.
 * · Exhaustive search over all pairings / operators / association orders.
 * · Two levels of de-duplication:
 *     1. canonical key  — flattens associativity + commutativity, so
 *        (1+2)+3, 3+(1+2), 2+(3+1)… are one entry.
 *     2. essence key    — additionally strips identity noise (×1, ÷1, +0,
 *        −0, x−x, x÷x). Used to group stylistic variants such as
 *        1×11+13÷1 vs 11+13×1 vs (11+13)÷(1×1) under one idea.
 *   Every displayed expression still uses all four cards.
 *
 * Runs in the browser (window.TwentyFourEngine) and in Node (module.exports).
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.TwentyFourEngine = api;
})(null, function factory() {
  'use strict';

  var TARGET_DEFAULT = 24;
  var OPS = ['+', '-', '*', '/'];

  /* ------------------------------------------------------------------ *
   * Fraction (BigInt)                                                    *
   * ------------------------------------------------------------------ */
  function gcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a;
  }
  function frac(n, d) {
    if (d === undefined) d = 1n;
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    var g = gcd(n, d) || 1n;
    return { n: n / g, d: d / g };
  }
  var F0 = frac(0n);
  var F1 = frac(1n);
  function fAdd(a, b) {
    return frac(a.n * b.d + b.n * a.d, a.d * b.d);
  }
  function fSub(a, b) {
    return frac(a.n * b.d - b.n * a.d, a.d * b.d);
  }
  function fMul(a, b) {
    return frac(a.n * b.n, a.d * b.d);
  }
  function fDiv(a, b) {
    if (b.n === 0n) return null;
    return frac(a.n * b.d, a.d * b.n);
  }
  function fEq(a, b) {
    return a.n === b.n && a.d === b.d;
  }
  function fIsInt(a) {
    return a.d === 1n;
  }
  function isZeroF(a) {
    return a.n === 0n;
  }
  function isOneF(a) {
    return a.n === 1n && a.d === 1n;
  }
  function fStr(a) {
    return a.d === 1n ? String(a.n) : a.n + '/' + a.d;
  }

  /* ------------------------------------------------------------------ *
   * Nodes                                                               *
   *   val      exact value                                              *
   *   key      canonical key (assoc + commut flattened)                  *
   *   essence  identity-stripped key (for grouping stylistic variants)   *
   *   tree     expression tree, used for display                         *
   *   sum/prod flattened term/factor lists: {s: sign|inverse, e, v}      *
   * ------------------------------------------------------------------ */
  function leaf(v, label) {
    var k = 'N' + fStr(v);
    return { val: v, key: k, essence: k, label: label, fracHit: false, tree: { kind: 'num', label: label || fStr(v), val: v } };
  }

  function termsOf(node) {
    return node.sum ? node.sum : [{ s: false, e: node.essence, v: node.val, k: node.key }];
  }
  function factorsOf(node) {
    return node.prod ? node.prod : [{ s: false, e: node.essence, v: node.val, k: node.key }];
  }

  /* canonical key: pure multiset of signed terms / inverted factors */
  function canonKey(list, tag) {
    var parts = list.map(function (it) {
      return (it.s ? '-' : '+') + it.k;
    }).sort();
    return tag + '[' + parts.join(',') + ']';
  }
  /* essence key: same, after dropping ×1/÷1/+0/−0 and cancelling x−x, x÷x */
  function essenceKey(list, tag, additive) {
    if (!additive && list.some(function (it) {
      return isZeroF(it.v);
    })) return 'E0';
    var items = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      if (additive ? isZeroF(it.v) : isOneF(it.v)) continue; // +0 / ×1 vanish
      items.push(it);
    }
    var keep = [];
    var pool = new Map(); // value-string -> list of kept indices
    for (i = 0; i < items.length; i++) {
      var cur = items[i];
      var vk = fStr(cur.v);
      var bucket = pool.get(vk) || [];
      var mate = -1;
      for (var p = 0; p < bucket.length; p++) if (keep[bucket[p]].s !== cur.s) {
        mate = bucket[p];
        break;
      }
      if (mate >= 0) {
        keep[mate] = null;
        bucket.splice(bucket.indexOf(mate), 1);
        pool.set(vk, bucket);
      } else {
        keep.push(cur);
        bucket.push(keep.length - 1);
        pool.set(vk, bucket);
      }
    }
    var live = [];
    for (i = 0; i < keep.length; i++) if (keep[i]) live.push(keep[i]);
    if (!live.length) return additive ? 'E0' : 'E1';
    if (live.length === 1 && !live[0].s) return live[0].e;
    var parts = live.map(function (x) {
      return (x.s ? '-' : '+') + x.e;
    }).sort();
    return tag + '(' + parts.join(',') + ')';
  }

  function combine(left, right, op) {
    var v;
    if (op === '+') v = fAdd(left.val, right.val);
    else if (op === '-') v = fSub(left.val, right.val);
    else if (op === '*') v = fMul(left.val, right.val);
    else {
      v = fDiv(left.val, right.val);
      if (!v) return null;
    }
    var node = {
      val: v,
      fracHit: left.fracHit || right.fracHit || !fIsInt(v),
      tree: { kind: 'op', op: op, l: left.tree, r: right.tree, val: v }
    };
    var flip = op === '-' || op === '/';
    var additive = op === '+' || op === '-';
    var own = additive ? termsOf(left) : factorsOf(left);
    var other = additive ? termsOf(right) : factorsOf(right);
    var list = own.slice();
    for (var i = 0; i < other.length; i++) {
      list.push({ s: flip ? !other[i].s : other[i].s, e: other[i].e, v: other[i].v, k: other[i].k });
    }
    var tag = additive ? 'S' : 'P';
    node[additive ? 'sum' : 'prod'] = list;
    node.key = canonKey(list, tag);
    node.essence = essenceKey(list, additive ? 'E+' : 'E*', additive);
    return node;
  }

  /* ------------------------------------------------------------------ *
   * Pretty printing with minimal parentheses                            *
   * ------------------------------------------------------------------ */
  var PREC = { '*': 2, '/': 2, '+': 1, '-': 1 };
  function precOf(node) {
    return node.kind === 'num' ? 3 : PREC[node.op];
  }
  function render(node, parentPrec, isRight) {
    if (node.kind === 'num') return node.label;
    var p = precOf(node);
    var need = p < parentPrec || (isRight && p === parentPrec && (node.op === '-' || node.op === '/'));
    var sym = node.op === '*' ? '×' : node.op === '/' ? '÷' : node.op;
    var out = render(node.l, p, false) + sym + render(node.r, p, true);
    return need ? '(' + out + ')' : out;
  }

  /* ------------------------------------------------------------------ *
   * Search                                                              *
   * ------------------------------------------------------------------ */
  function search(numbers, target, firstOnly) {
    target = target === undefined ? TARGET_DEFAULT : target;
    var targetF = frac(BigInt(target));
    var found = new Map();
    var stop = { hit: false };

    function walk(nodes) {
      if (stop.hit) return;
      if (nodes.length === 1) {
        if (fEq(nodes[0].val, targetF)) {
          var n = nodes[0];
          if (!found.has(n.key)) {
            found.set(n.key, {
              key: n.key,
              essence: n.essence,
              display: render(n.tree, 0, false) + ' = ' + target,
              length: render(n.tree, 0, false).length,
              fractionUsed: n.fracHit
            });
          }
          if (firstOnly) stop.hit = true;
        }
        return;
      }
      for (var i = 0; i < nodes.length && !stop.hit; i++) {
        for (var j = i + 1; j < nodes.length && !stop.hit; j++) {
          var rest = [];
          for (var m = 0; m < nodes.length; m++) if (m !== i && m !== j) rest.push(nodes[m]);
          for (var o = 0; o < OPS.length && !stop.hit; o++) {
            var merged = combine(nodes[i], nodes[j], OPS[o]);
            if (merged) walk(rest.concat([merged]));
            if (OPS[o] === '-' || OPS[o] === '/') {
              var rev = combine(nodes[j], nodes[i], OPS[o]);
              if (rev) walk(rest.concat([rev]));
            }
          }
        }
      }
    }

    walk(numbers.map(function (n) {
      return leaf(frac(BigInt(Number(n))));
    }));

    var raw = Array.from(found.values());
    raw.sort(function (a, b) {
      if (a.fractionUsed !== b.fractionUsed) return a.fractionUsed ? 1 : -1;
      if (a.length !== b.length) return a.length - b.length;
      return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
    });

    // group stylistic variants under their essence
    var groups = [];
    var byEssence = new Map();
    for (var r = 0; r < raw.length; r++) {
      var s = raw[r];
      var g = byEssence.get(s.essence);
      if (!g) {
        g = { display: s.display, fractionUsed: s.fractionUsed, variants: [] };
        byEssence.set(s.essence, g);
        groups.push(g);
      }
      if (s.display !== g.display) g.variants.push(s.display);
    }
    return {
      target: target,
      solutions: groups,
      total: groups.length,
      raw: raw,
      rawTotal: raw.length
    };
  }

  function solve(numbers, target) {
    return search(numbers, target, false);
  }
  function hasSolution(numbers, target) {
    return search(numbers, target === undefined ? TARGET_DEFAULT : target, true).total > 0;
  }
  function isUnsolvable(numbers, target) {
    return !hasSolution(numbers, target);
  }

  /**
   * Best approximation: closest reachable value to the target *without*
   * hitting it. Used to annotate unsolvable hands ("最接近的是 …").
   */
  function bestApprox(numbers, target) {
    target = target === undefined ? TARGET_DEFAULT : target;
    var targetF = frac(BigInt(target));
    var best = null;
    function walk(nodes) {
      if (nodes.length === 1) {
        var n = nodes[0];
        var d = subAbs(n.val, targetF);
        if (d.n === 0n) return;
        if (best && cmpAbs(d, best.diff) >= 0) return;
        best = { diff: d, value: n.val, valueText: fStr(n.val), display: render(n.tree, 0, false) + ' = ' + fStr(n.val) };
        return;
      }
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var rest = [];
          for (var m = 0; m < nodes.length; m++) if (m !== i && m !== j) rest.push(nodes[m]);
          for (var o = 0; o < OPS.length; o++) {
            var merged = combine(nodes[i], nodes[j], OPS[o]);
            if (merged) walk(rest.concat([merged]));
            if (OPS[o] === '-' || OPS[o] === '/') {
              var rev = combine(nodes[j], nodes[i], OPS[o]);
              if (rev) walk(rest.concat([rev]));
            }
          }
        }
      }
    }
    walk(numbers.map(function (n) {
      return leaf(frac(BigInt(Number(n))));
    }));
    if (!best) return null;
    best.diffText = fStr(best.diff);
    var signed = fSub(best.value, targetF);
    best.below = signed.n < 0n; // true → the closest value undershoots the target
    return best;
  }
  function subAbs(a, b) {
    var d = fSub(a, b);
    return d.n < 0n ? { n: -d.n, d: d.d } : d;
  }
  function cmpAbs(a, b) {
    var l = a.n * b.d, r = b.n * a.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  /* ------------------------------------------------------------------ *
   * Dealing                                                             *
   * ------------------------------------------------------------------ */
  function makeRng(seed) {
    if (seed === undefined) seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
    var s = seed >>> 0 || 1;
    var fn = function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 0x100000000;
    };
    fn.seed = seed >>> 0;
    return fn;
  }
  function randomHand(rng, min, max, size) {
    rng = rng || Math.random;
    min = min || 1;
    max = max || 13;
    size = size || 4;
    var hand = [];
    for (var i = 0; i < size; i++) hand.push(min + Math.floor(rng() * (max - min + 1)));
    return hand.sort(function (a, b) {
      return a - b;
    });
  }

  /**
   * Deal a hand that HAS a solution.
   * flavour: 'easy' → many ideas, no fraction needed
   *          'hard' → few ideas, fraction intermediates preferred
   */
  function dealSolvable(rng, opts) {
    opts = opts || {};
    var minCard = opts.minCard || 1;
    var maxCard = opts.maxCard || 13;
    var target = opts.target === undefined ? TARGET_DEFAULT : opts.target;
    var flavour = opts.flavour || 'normal';
    var tries = opts.tries || 500;
    var best = null;
    for (var t = 0; t < tries; t++) {
      var hand = randomHand(rng, minCard, maxCard);
      var res = solve(hand, target);
      if (!res.total) continue;
      var needsFrac = res.solutions.every(function (g) {
        return g.fractionUsed;
      });
      if (flavour === 'easy' && (needsFrac || res.total < 3)) {
        if (!best || best.score < res.total) best = { hand: hand, result: res, score: res.total };
        continue;
      }
      if (flavour === 'hard' && (!needsFrac || res.total > 2)) {
        if (!best || (needsFrac && best.score > res.total)) best = { hand: hand, result: res, score: res.total };
        continue;
      }
      return { hand: hand, result: res, flavour: flavour };
    }
    if (best) return { hand: best.hand, result: best.result, flavour: flavour };
    var fb = flavour === 'hard' ? [1, 5, 5, 5] : [1, 2, 3, 4];
    return { hand: fb, result: solve(fb, target), flavour: flavour };
  }

  /** Deal a hand with NO solution. */
  function dealUnsolvable(rng, opts) {
    opts = opts || {};
    var tries = opts.tries || 500;
    for (var t = 0; t < tries; t++) {
      var hand = randomHand(rng, opts.minCard || 1, opts.maxCard || 13, opts.size);
      if (isUnsolvable(hand, opts.target)) return { hand: hand };
    }
    return { hand: [1, 1, 1, 1] };
  }

  /* ------------------------------------------------------------------ *
   * Whole-space enumeration (drives the statistics panel)                *
   * ------------------------------------------------------------------ */
  var comboCache = null;
  function allCombos(min, max, target) {
    min = min || 1;
    max = max || 13;
    target = target === undefined ? TARGET_DEFAULT : target;
    var cacheKey = min + '-' + max + '-' + target;
    if (comboCache && comboCache.key === cacheKey) return comboCache.value;
    var out = { solvable: [], unsolvable: [], hardest: [], richest: [] };
    var maxIdeas = 0;
    for (var a = min; a <= max; a++) {
      for (var b = a; b <= max; b++) {
        for (var c = b; c <= max; c++) {
          for (var d = c; d <= max; d++) {
            var hand = [a, b, c, d];
            var res = solve(hand, target);
            if (!res.total) out.unsolvable.push(hand);
            else {
              out.solvable.push(hand);
              if (res.total > maxIdeas) {
                maxIdeas = res.total;
                out.richest = hand;
              }
              if (res.total === 1 && !out.hardest.length) out.hardest.push(hand);
            }
          }
        }
      }
    }
    out.total = out.solvable.length + out.unsolvable.length;
    out.maxIdeas = maxIdeas;
    comboCache = { key: cacheKey, value: out };
    return out;
  }

  function stats(min, max, target) {
    var c = allCombos(min, max, target);
    return {
      combos: c.total,
      solvable: c.solvable.length,
      unsolvable: c.unsolvable.length,
      deadRate: c.unsolvable.length / c.total,
      richest: c.richard,
      richestCount: c.maxIdeas,
      hardest: c.hardest.slice(0, 6)
    };
  }

  /* ------------------------------------------------------------------ *
   * Cards / ranks                                                       *
   * ------------------------------------------------------------------ */
  var RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  var SUITS = ['♠', '♥', '♣', '♦'];
  var RED_SUITS = { '♥': 1, '♦': 1 };
  function rankLabel(n) {
    return RANK_LABELS[n] || String(n);
  }

  /* ------------------------------------------------------------------ *
   * Hand-built expression checker (challenge mode self-audit)            *
   * tokens: {t:'n', v} | {t:'o', v} | {t:'('} | {t:')'}                    *
   *   multiset: card values still available to build the expression.       *
   *   Numbers are consumed from the multiset, so "1+2+3+3" against          *
   *   hand {1,2,3,4} is rejected even though 1+2+3+3 = 9: the 4 was         *
   *   never played and the second 3 has no partner.                         *
   * ------------------------------------------------------------------ */
  function evaluateTokens(tokens, hand, target) {
    target = target === undefined ? TARGET_DEFAULT : target;
    var pos = 0;
    var err = null;
    var pool = (hand || []).slice().map(Number);
    var taken = [];
    var surplus = 0;
    function fail(msg) {
      if (!err) err = msg;
      return null;
    }
    function peek() {
      return tokens[pos];
    }
    function expr() {
      var left = term();
      if (!left) return null;
      while (peek() && peek().t === 'o' && (peek().v === '+' || peek().v === '-')) {
        var op = tokens[pos++].v;
        var r = term();
        if (!r) return null;
        left = combine(left, r, op);
        if (!left) return fail('出现了除以 0');
      }
      return left;
    }
    function term() {
      var left = factor();
      if (!left) return null;
      while (peek() && peek().t === 'o' && (peek().v === '*' || peek().v === '/')) {
        var op = tokens[pos++].v;
        var r = factor();
        if (!r) return null;
        left = combine(left, r, op);
        if (!left) return fail('出现了除以 0');
      }
      return left;
    }
    function factor() {
      var t = peek();
      if (!t) return fail('算式还没写完');
      if (t.t === '(') {
        pos++;
        var inner = expr();
        if (!inner) return null;
        if (!peek() || peek().t !== ')') return fail('少了右括号');
        pos++;
        return inner;
      }
      if (t.t === 'n') {
        pos++;
        var at = pool.indexOf(Number(t.v));
        if (at >= 0) {
          taken.push(pool.splice(at, 1)[0]);
        } else {
          surplus++; // value not in the hand any more
        }
        return leaf(frac(BigInt(Number(t.v))));
      }
      return fail('这里需要一个数');
    }
    if (!tokens || !tokens.length) return { ok: false, error: '先拼出你的算式' };
    var node = expr();
    if (!node) return { ok: false, error: err || '算式无法解析' };
    if (pos < tokens.length) {
      var tail = peek();
      return { ok: false, error: tail.t === ')' ? '括号多了一个' : '算式末尾有多余符号' };
    }
    var numbers = taken.length + surplus;
    var leftover = pool.length; // cards of the hand never played
    var usageError = null;
    if (surplus) usageError = '用掉了手里没有的数字';
    else if (leftover) usageError = '还有 ' + leftover + ' 张牌没用上';

    return {
      ok: true,
      value: node.val,
      valueText: fStr(node.val),
      hit: fEq(node.val, frac(BigInt(target))) && !surplus && !leftover,
      numbersUsed: numbers,
      missing: leftover,
      surplus: surplus,
      complete: numbers > 0 && !leftover && !surplus && (!hand || numbers === hand.length),
      usageError: usageError,
      fractionUsed: node.fracHit,
      expression: render(node.tree, 0, false)
    };
  }

  return {
    TARGET: TARGET_DEFAULT,
    frac: frac,
    fStr: fStr,
    fEq: fEq,
    solve: solve,
    hasSolution: hasSolution,
    isUnsolvable: isUnsolvable,
    bestApprox: bestApprox,
    makeRng: makeRng,
    randomHand: randomHand,
    dealSolvable: dealSolvable,
    dealUnsolvable: dealUnsolvable,
    allCombos: allCombos,
    stats: stats,
    rankLabel: rankLabel,
    SUITS: SUITS,
    RED_SUITS: RED_SUITS,
    evaluateTokens: evaluateTokens
  };
});

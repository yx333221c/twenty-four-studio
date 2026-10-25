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
   *   ess      essence object: identity-stripped structure (grouping)     *
   *   tree     expression tree, used for display                         *
   *   sum/prod flattened term/factor lists: {s, e, v, k}                  *
   * ------------------------------------------------------------------ */
  function leaf(v, label) {
    var k = 'N' + fStr(v);
    return {
      val: v,
      key: k,
      ess: { str: k, add: false, mul: false, parts: null, v: v },
      label: label,
      fracHit: false,
      tree: { kind: 'num', label: label || fStr(v), val: v }
    };
  }

  function termsOf(node) {
    return node.sum ? node.sum : [{ s: false, e: node.ess, v: node.val, k: node.key }];
  }
  function factorsOf(node) {
    return node.prod ? node.prod : [{ s: false, e: node.ess, v: node.val, k: node.key }];
  }

  /* canonical key: pure multiset of signed terms / inverted factors */
  function canonKey(list, tag) {
    var parts = list.map(function (it) {
      return (it.s ? '-' : '+') + it.k;
    }).sort();
    return tag + '[' + parts.join(',') + ']';
  }

  /* ------------------------------------------------------------------ *
   * Essence: the same normalisation, plus the identity laws              *
   *   x+0 = x−0 = x        x×1 = x÷1 = x        x−x = 0        x÷x = 1     *
   * Nested chains of the same kind are spliced, so                        *
   *   10÷1+2+12   ≡   10+1×(2+12)   ≡   (12+2+10)÷1                       *
   * collapse to one idea. Atoms of the *other* kind stay opaque.          *
   * ------------------------------------------------------------------ */
  function essAtom(str, v) {
    return { str: str, add: false, mul: false, parts: null, v: v };
  }
  function essSerialize(add, parts) {
    var body = parts.map(function (p) {
      return (p.s ? '-' : '+') + p.e.str;
    }).sort();
    return (add ? '+(' : '*(') + body.join(',') + ')';
  }
  function essNorm(add, parts, value) {
    var kept = [];
    var i, p;
    if (!add && parts.some(function (x) {
      return isZeroF(x.v);
    })) return essAtom('N0', F0); // anything × 0

    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (add ? isZeroF(p.v) : isOneF(p.v)) continue; // +0 / ×1 / ÷1 vanish
      kept.push(p);
    }
    // cancel opposite partners of equal value: +x/−x, ×x/÷x
    var live = [];
    var pool = new Map();
    for (i = 0; i < kept.length; i++) {
      p = kept[i];
      var vk = fStr(p.v);
      var bucket = pool.get(vk) || [];
      var mate = -1;
      for (var q = 0; q < bucket.length; q++) if (live[bucket[q]].s !== p.s) {
        mate = bucket[q];
        break;
      }
      if (mate >= 0) {
        live[mate] = null;
        bucket.splice(bucket.indexOf(mate), 1);
        pool.set(vk, bucket);
      } else {
        live.push(p);
        bucket.push(live.length - 1);
        pool.set(vk, bucket);
      }
    }
    var out = [];
    for (i = 0; i < live.length; i++) if (live[i]) out.push(live[i]);

    if (!out.length) return add ? essAtom('N0', F0) : essAtom('N1', F1);
    if (out.length === 1 && !out[0].s) return out[0].e; // propagate the child structure
    return { str: essSerialize(add, out), add: add, mul: !add, parts: out, v: value };
  }
  /* splice a child essence into a parent chain, but only when the kinds
     match: a sum may absorb a sum (sign flips on −), a product may absorb a
     product (inverts on ÷). A product child inside a sum stays opaque,
     because 5 − (1÷5) is 5 + (−1/5), never 5 + 5. */
  function spliceInto(into, child, flip, additive) {
    var sameKind = additive ? child.add : child.mul;
    if (sameKind && child.parts) {
      for (var i = 0; i < child.parts.length; i++) {
        var p = child.parts[i];
        into.push({ s: flip ? !p.s : p.s, e: p.e, v: p.v });
      }
    } else {
      into.push({ s: !!flip, e: child, v: child.v });
    }
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

    /* structural key (identity-preserving): flattens assoc + commut only */
    var own = additive ? termsOf(left) : factorsOf(left);
    var other = additive ? termsOf(right) : factorsOf(right);
    var list = own.slice();
    for (var i = 0; i < other.length; i++) {
      list.push({ s: flip ? !other[i].s : other[i].s, e: other[i].e, v: other[i].v, k: other[i].k });
    }
    node[additive ? 'sum' : 'prod'] = list;
    node.key = canonKey(list, additive ? 'S' : 'P');

    /* essence (identity-folding): splice same-kind chains, drop ×1/+0, cancel */
    var parts = [];
    spliceInto(parts, left.ess, false, additive);
    spliceInto(parts, right.ess, flip, additive);
    node.ess = essNorm(additive, parts, v);
    return node;
  }

  /* ------------------------------------------------------------------ *
   * Pretty printing with minimal parentheses                            *
   *   left child  needs parens when it binds looser than the parent      *
   *   right child needs parens when it binds looser *or equally* and the  *
   *   parent is − or ÷ (those are not associative on the right):          *
   *     a−(b+c) ✓ parens   a+(b−c) ✗ parens   a÷(b×c) ✓   a×(b÷c) ✗       *
   * ------------------------------------------------------------------ */
  var PREC = { '*': 2, '/': 2, '+': 1, '-': 1 };
  function precOf(node) {
    return node.kind === 'num' ? 3 : PREC[node.op];
  }
  function render(node, parentPrec, isRight, parentOp) {
    if (node.kind === 'num') return node.label;
    var p = precOf(node);
    var need = p < parentPrec ||
      (isRight && p === parentPrec && (parentOp === '-' || parentOp === '/'));
    var sym = node.op === '*' ? '×' : node.op === '/' ? '÷' : node.op;
    var out = render(node.l, p, false, node.op) + sym + render(node.r, p, true, node.op);
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
              essence: n.ess.str, // string form: stable Map key
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

  /**
   * Size of the search space the solver walks: at each reduction step pick an
   * unordered pair of nodes and one of six ordered operator applications
   * (+, ×, − in both directions, ÷ in both directions). For four cards this is
   * (6·6) × (3·6) × (1·6) = 3888 candidate derivations.
   */
  function countPaths(count) {
    var total = 1;
    for (var len = (count || 4); len > 1; len--) {
      total *= (len * (len - 1) / 2) * 6;
    }
    return total;
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
    var signedGap = fSub(node.val, frac(BigInt(target)));
    var absGap = signedGap.n < 0n ? { n: -signedGap.n, d: signedGap.d } : signedGap;

    return {
      ok: true,
      value: node.val,
      valueText: fStr(node.val),
      hit: fEq(node.val, frac(BigInt(target))) && !surplus && !leftover,
      gapText: fStr(absGap),
      gapBelow: signedGap.n < 0n,
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
    countPaths: countPaths,
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

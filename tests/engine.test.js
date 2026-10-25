/* Node tests for js/engine.js — run with: node tests/engine.test.js */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'js', 'engine.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---- independent re-evaluator for rendered strings ----
   Leaf labels are always plain integers, so digits+dot are number chars;
   '/' only appears inside a "a/b" result label on the right-hand side. */
function evalDisplay(str) {
  const [exprRaw, rhs] = str.split('=');
  const src = exprRaw.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  let i = 0;
  const expr = () => { let v = term(); while (src[i] === '+' || src[i] === '-') { const o = src[i++]; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = factor(); while (src[i] === '*' || src[i] === '/') { const o = src[i++]; const r = factor(); v = o === '*' ? v * r : v / r; } return v; };
  const factor = () => {
    if (src[i] === '(') { i++; const v = expr(); if (src[i] !== ')') throw new Error('bad paren in ' + str); i++; return v; }
    let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
    if (j === i) throw new Error('expected number at ' + i + ' in ' + src);
    const value = Number(src.slice(i, j)); i = j;
    return value;
  };
  const out = expr();
  if (i !== src.length) throw new Error('trailing junk in ' + str);
  const target = Number(rhs.trim());
  if (Math.abs(out - target) > 1e-9) throw new Error('MISMATCH: ' + str + ' -> ' + out);
  return target;
}
/* every rendered leaf must be one of the original integer cards */
function numsIn(str) {
  return (str.split('=')[0].match(/\d+/g) || []).map(Number).sort((a, b) => a - b);
}
function allDisplays(res) {
  const list = [];
  for (const g of res.solutions) { list.push(g.display); for (const v of g.variants) list.push(v); }
  return list;
}
function verifyAll(hand, res) {
  const orig = [...hand].sort((a, b) => a - b).join();
  const bad = [];
  for (const d of allDisplays(res)) {
    try { evalDisplay(d); } catch (e) { bad.push(e.message); continue; }
    const used = numsIn(d).join();
    if (used !== orig) bad.push('cards ' + used + ' ≠ ' + orig + ' :: ' + d);
  }
  return bad;
}

console.log('\n=== classic hard hands (fraction intermediates) ===');
const hard = [[1, 5, 5, 5], [3, 3, 7, 7], [1, 4, 5, 6], [3, 8, 3, 8], [1, 2, 3, 4], [4, 6, 8, 8]];
for (const h of hard) {
  const r = E.solve(h);
  ok(h + ' is solvable', r.total > 0, 'ideas=' + r.total + ' raw=' + r.rawTotal);
  const bad = verifyAll(h, r);
  ok(h + ' → all ' + allDisplays(r).length + ' renders verify & use exactly the 4 cards', bad.length === 0, bad[0]);
}

console.log('\n=== exhaustive render verification: every printed formula re-evaluates ===');
let renderChecked = 0, renderBad = [];
for (let a = 1; a <= 13; a++)
  for (let b = a; b <= 13; b++)
    for (let c = b; c <= 13; c++)
      for (let d = c; d <= 13; d++) {
        const h = [a, b, c, d];
        const r = E.solve(h);
        for (const disp of allDisplays(r)) {
          renderChecked++;
          try {
            evalDisplay(disp);
            const used = numsIn(disp).join();
            if (used !== [...h].sort((x, y) => x - y).join()) renderBad.push('cards: ' + disp);
          } catch (e) {
            renderBad.push(e.message);
            if (renderBad.length > 4) break;
          }
        }
        if (renderBad.length > 4) break;
      }
ok('all ' + renderChecked + ' printed formulas are arithmetically true and use exactly the 4 cards',
  renderBad.length === 0, renderBad.slice(0, 3).join(' | '));

console.log('\n=== parentheses: non-associative right children must stay wrapped ===');
// regression: 6,7,8,10 → tree 6×7 − (8+10); dropping those parens prints 42−8+10 = 44
{
  const r = E.solve([6, 7, 8, 10]);
  const bad = verifyAll([6, 7, 8, 10], r);
  ok('6,7,8,10 formulas all true', bad.length === 0, bad[0]);
  ok('a−(b+c) keeps its parentheses', r.solutions.some(s => /-\(.+\+.+\)/.test(s.display)) ||
    !r.solutions.some(s => /[^()]\d+-\d+\+\d+ = 24$/.test(s.display.replace(/\s/g, ''))),
    r.solutions.map(s => s.display).join(' | '));
}
{
  const r = E.solve([2, 3, 4, 5]);
  ok('2,3,4,5 formulas all true', verifyAll([2, 3, 4, 5], r).length === 0, verifyAll([2, 3, 4, 5], r)[0]);
}

console.log('\n=== nested-chain splicing (essence absorbs same-kind children) ===');
{
  // 1,2,10,12: fourteen raw forms, all of them "add the three, ×1/÷1 somewhere"
  const r = E.solve([1, 2, 10, 12]);
  ok('1,2,10,12 collapses 14 raw forms to 1 idea', r.rawTotal === 14 && r.total === 1,
    'raw=' + r.rawTotal + ' ideas=' + r.total);
  ok('the surviving idea still prints all four cards', numsIn(r.solutions[0].display).length === 4,
    r.solutions[0].display);
  // 3×4÷(1÷2) is 1×2×3×4 wearing a hat: product inside product must splice
  const r2 = E.solve([1, 2, 3, 4]);
  ok('1,2,3,4 → 3 ideas from 4 raw forms (÷(1÷2) merges into ×1×2×3×4)',
    r2.rawTotal === 4 && r2.total === 3, 'raw=' + r2.rawTotal + ' ideas=' + r2.total);
  // a product child of a sum must NOT splice: 5-(1÷5) keeps its shape
  const r3 = E.solve([1, 5, 5, 5]);
  ok('5,5,5,1 stays one idea and keeps the fraction structure',
    r3.total === 1 && /\(5-1÷5\)/.test(r3.solutions[0].display), r3.solutions[0].display);
  // over-fold guard: genuinely different ideas must not merge
  const r4 = E.solve([2, 3, 6, 12]);
  ok('densest hand keeps many distinct ideas (no over-folding)', r4.total >= 8, 'ideas=' + r4.total);
  ok('every idea of 2,3,6,12 verifies', verifyAll([2, 3, 6, 12], r4).length === 0,
    verifyAll([2, 3, 6, 12], r4)[0]);
}

console.log('\n=== reference solution counts (published 24-game tables) ===');
// 1,5,5,5 and 3,3,7,7 each have exactly ONE idea; 1,2,3,4 has 4 distinct canonical forms.
ok('1,5,5,5 → 1 idea', E.solve([1, 5, 5, 5]).total === 1, String(E.solve([1, 5, 5, 5]).total));
ok('3,3,7,7 → 1 idea', E.solve([3, 3, 7, 7]).total === 1, String(E.solve([3, 3, 7, 7]).total));
ok('5,5,5,1 shows the fraction trick', /÷/.test(E.solve([1, 5, 5, 5]).solutions[0].display), E.solve([1, 5, 5, 5]).solutions[0].display);
ok('3,3,7,7 shows (3+3÷7)×7', /7/.test(E.solve([3, 3, 7, 7]).solutions[0].display), E.solve([3, 3, 7, 7]).solutions[0].display);

console.log('\n=== identity-noise grouping (essence) ===');
const dense = E.solve([1, 1, 11, 13]);
ok('1,1,11,13 raw forms collapse into few ideas', dense.rawTotal >= 20 && dense.total < dense.rawTotal / 2,
  'raw=' + dense.rawTotal + ' ideas=' + dense.total + ' → ' + dense.solutions.map(s => s.display).join(' | '));
ok('idea count never exceeds raw count', dense.total <= dense.rawTotal);
const ones = E.solve([1, 1, 1, 1]);
ok('1,1,1,1 has no solutions', ones.total === 0);
ok('every idea keeps a full 4-card expression', dense.solutions.every(g => numsIn(g.display).length === 4),
  dense.solutions.find(g => numsIn(g.display).length !== 4)?.display);

console.log('\n=== known unsolvable hands ===');
for (const h of [[1, 1, 1, 1], [1, 1, 1, 2], [13, 13, 13, 13], [2, 2, 2, 2], [1, 1, 2, 2], [1, 1, 1, 3], [11, 11, 11, 11]]) {
  ok(h.join() + ' unsolvable', E.isUnsolvable(h) && E.solve(h).total === 0);
}
console.log('\n=== known solvable lookalikes (regression: not over-pruned) ===');
for (const h of [[5, 5, 5, 5], [3, 3, 3, 3], [12, 13, 13, 13], [2, 2, 2, 3]]) {
  ok(h.join() + ' solvable', !E.isUnsolvable(h));
}

console.log('\n=== exhaustive cross-check over all 1820 combos ===');
let mismatch = 0, checked = 0, unsolv = 0, maxIdeas = 0, maxHand = null;
for (let a = 1; a <= 13; a++)
  for (let b = a; b <= 13; b++)
    for (let c = b; c <= 13; c++)
      for (let d = c; d <= 13; d++) {
        const h = [a, b, c, d];
        const fast = E.hasSolution(h);
        const slow = E.solve(h);
        checked++;
        if (fast !== (slow.total > 0)) mismatch++;
        if (!slow.total) unsolv++;
        if (slow.total > maxIdeas) { maxIdeas = slow.total; maxHand = h; }
      }
ok('hasSolution agrees with solve() on all ' + checked + ' combos', mismatch === 0, mismatch + ' mismatches');
ok('unsolvable combos = 458 (published value)', unsolv === 458, String(unsolv));
console.log('    densest hand: ' + maxHand.join(',') + ' → ' + maxIdeas + ' ideas');
const st = E.stats(1, 13, 24);
ok('stats() agrees with the sweep', st.combos === checked && st.unsolvable === unsolv && st.richestCount === maxIdeas,
  JSON.stringify(st));

console.log('\n=== deal helpers ===');
const rng = E.makeRng(42);
let badSolv = 0, badUnsolv = 0;
for (let i = 0; i < 60; i++) if (!E.solve(E.dealSolvable(rng).hand).total) badSolv++;
for (let i = 0; i < 60; i++) if (!E.isUnsolvable(E.dealUnsolvable(rng).hand)) badUnsolv++;
ok('dealSolvable ×60 always solvable', badSolv === 0, badSolv + ' bad');
ok('dealUnsolvable ×60 always unsolvable', badUnsolv === 0, badUnsolv + ' bad');
const easy = E.dealSolvable(E.makeRng(1), { flavour: 'easy' });
const hardD = E.dealSolvable(E.makeRng(1), { flavour: 'hard' });
ok('easy flavour has ≥3 ideas and no forced fraction', easy.result.total >= 3 && easy.result.solutions.some(s => !s.fractionUsed),
  easy.hand.join(',') + ' ideas=' + easy.result.total);
ok('hard flavour forces fraction thinking', hardD.result.solutions.every(s => s.fractionUsed),
  hardD.hand.join(',') + ' → ' + hardD.result.solutions.map(s => s.display).join(' | '));
const r1 = E.makeRng(7), r2 = E.makeRng(7);
ok('seeded rng is reproducible', E.randomHand(r1).join() === E.randomHand(r2).join());
const rangeHands = [];
for (let i = 0; i < 200; i++) rangeHands.push(E.randomHand(E.makeRng(i), 1, 9));
ok('range clamp works (1–9 deal stays in range)', rangeHands.every(h => h.every(v => v >= 1 && v <= 9)));

console.log('\n=== expression checker ===');
const T = (str, hand) => {
  // digit runs become one number
  const out = [];
  for (let i = 0; i < str.length;) {
    const ch = str[i];
    if (/[0-9]/.test(ch)) {
      let j = i; while (j < str.length && /[0-9]/.test(str[j])) j++;
      out.push({ t: 'n', v: Number(str.slice(i, j)) }); i = j;
    } else {
      if ('+-*/'.includes(ch)) out.push({ t: 'o', v: ch });
      else if (ch === '(') out.push({ t: '(' });
      else if (ch === ')') out.push({ t: ')' });
      i++;
    }
  }
  return out;
};
ok('3*(4+6)/5 == 6', E.evaluateTokens(T('3*(4+6)/5'), [3, 4, 6, 5], 6).hit === true);
ok('5*(5-1/5) == 24 with fraction intermediate',
  E.evaluateTokens(T('5*(5-1/5)'), [5, 5, 5, 1], 24).hit === true);
ok('correct value but wrong target is not a hit',
  E.evaluateTokens(T('1+2+3+4'), [1, 2, 3, 4], 24).hit === false);
ok('incomplete card usage flagged',
  E.evaluateTokens(T('4*6'), [4, 6, 8, 8], 24).complete === false);
ok('missing right paren detected', E.evaluateTokens(T('(1+2*3+4'), [1, 2, 3, 4], 10).ok === false);
ok('extra right paren detected', E.evaluateTokens(T('1+2)+3'), [1, 2, 3, 4], 10).ok === false);
ok('division by zero detected', E.evaluateTokens(T('1/(2-2)+3'), [1, 2, 2, 3], 24).ok === false);
ok('empty input reports error', E.evaluateTokens([], [1, 2, 3, 4], 24).ok === false);
ok('trailing operator reports error', E.evaluateTokens(T('1+2+3+'), [1, 2, 3, 4], 6).ok === false);
ok('unused card is reported as missing', E.evaluateTokens(T('1+2+3+3'), [1, 2, 3, 4], 9).missing === 1);
ok('value text is exact fraction', E.evaluateTokens(T('1/3'), [1, 3, 1, 1], 24).valueText === '1/3');
ok('exactness: 3+3/7 then ×7 is exactly 24 (float would miss it)',
  E.evaluateTokens(T('(3+3/7)*7'), [3, 3, 7, 7], 24).hit === true);
ok('exactness: 12*(1+1)*1 == 24 treats 12 as one card',
  E.evaluateTokens(T('12*(1+1)*1'), [12, 1, 1, 1], 24).hit === true);
ok('a fifth number beyond the hand is refused',
  E.evaluateTokens(T('12*(1+1+1+1)'), [12, 1, 1, 1], 48).hit === false);

console.log('\n=== best approximation for dead hands ===');
const ap1 = E.bestApprox([1, 1, 1, 1], 24);
ok('1,1,1,1 tops out at 4 (diff 20, below)', ap1 && ap1.valueText === '4' && ap1.diffText === '20' && ap1.below, ap1 && ap1.display);
const ap2 = E.bestApprox([2, 2, 2, 2], 24);
ok('2,2,2,2 closest = 16 (diff 8, below)', ap2 && ap2.valueText === '16' && ap2.below, ap2 && ap2.display);
const ap3 = E.bestApprox([13, 13, 13, 13], 24);
ok('13,13,13,13 closest = 25 (diff 1, overshoots)', ap3 && ap3.valueText === '25' && ap3.diffText === '1' && !ap3.below, ap3 && ap3.display);
const ap4 = E.bestApprox([1, 1, 1, 2], 24);
ok('1,1,1,2 closest = 6 (diff 18)', ap4 && Number(ap4.diffText) === 18, ap4 && ap4.display);
ok('approx never equals the target', [ap1, ap2, ap3, ap4].every(a => a && a.valueText !== '24'));
const ap5 = E.bestApprox([1, 1, 1, 3], 24);
console.log('    1,1,1,3 → ' + (ap5 && ap5.display) + ' (diff ' + (ap5 && ap5.diffText) + ')');

console.log('\n=== target variants ===');
ok('target 10 with 1,2,3,4', E.solve([1, 2, 3, 4], 10).total > 0);
ok('target 1 with 1,1,1,1', E.solve([1, 1, 1, 1], 1).total > 0);
ok('target 24 rejected for 1,1,1,1', E.solve([1, 1, 1, 1], 24).total === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exitCode = fail ? 1 : 0;

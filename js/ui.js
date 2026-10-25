/* ══════════════════════════════════════════════════════════════
   廿四牌局 · UI controller
   Three workbenches share one exact solver (js/engine.js) and one
   precomputed landscape (js/data.js).
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var E = window.TwentyFourEngine;
  var D = window.TwentyFourData || { ranges: {} };
  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  var TARGET = E.TARGET;

  /* ── storage ─────────────────────────────────────────── */
  var store = {
    get: function (k, dflt) {
      try {
        var v = localStorage.getItem('tfs.' + k);
        return v === null ? dflt : JSON.parse(v);
      } catch (e) {
        return dflt;
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem('tfs.' + k, JSON.stringify(v));
      } catch (e) { /* private mode */ }
    }
  };

  /* ── toast ───────────────────────────────────────────── */
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2100);
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var done = false;
      try {
        done = document.execCommand('copy');
      } catch (e) {
        done = false;
      }
      document.body.removeChild(ta);
      toast(done ? okMsg : '复制失败，请手动选取');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg);
      }, fallback);
    } else fallback();
  }

  /* ── formatting helpers ──────────────────────────────── */
  function fmtTime(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function handCode(seed) {
    return '#' + (seed >>> 0).toString(16).toUpperCase().slice(-4).padStart(4, '0');
  }
  function isRed(suit) {
    return suit === '♥' || suit === '♦';
  }
  /* Poker mode shows A/J/Q/K glyphs on the card faces; the 1–9 mode shows
     plain digits. All maths (slate, idea lists, decks) stays numeric. */
  function faceName(v) {
    return currentRange().max === 13 ? E.rankLabel(v) : String(v);
  }
  /* numeric hint under a letter glyph, so J / Q / K never confuse the player */
  function altHint(v) {
    return faceName(v) === String(v) ? '' : '<i class="alt-val">' + v + '</i>';
  }

  /* ══════════════════════════════════════════════════════
     Tabs
     ══════════════════════════════════════════════════════ */
  var tabs = $$('.rail-tab');
  function showPanel(name) {
    tabs.forEach(function (t) {
      var on = t.dataset.panel === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ['arena', 'audit', 'deck'].forEach(function (key) {
      var p = $('#panel-' + key);
      p.classList.toggle('is-active', key === name);
      p.hidden = key !== name;
    });
    location.hash = '#' + name;
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      showPanel(t.dataset.panel);
    });
  });

  /* ══════════════════════════════════════════════════════
     Global controls: range + theme
     ══════════════════════════════════════════════════════ */
  var rangeSel = $('#range-select');
  function currentRange() {
    var key = rangeSel.value;
    var r = (D.ranges[key] && D.ranges[key].range) || { min: 1, max: 13 };
    return { key: key, min: r.min, max: r.max };
  }
  rangeSel.value = store.get('range', '1-13');
  rangeSel.addEventListener('change', function () {
    store.set('range', rangeSel.value);
    arena.deal();
    mint();
    landscape.render();
    toast('牌面范围已切换为 ' + (currentRange().max === 13 ? '扑克 A–K' : '数字 1–9'));
  });

  var themeBtn = $('#theme-toggle');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    themeBtn.textContent = t === 'felt' ? '🂠' : '🂡';
    store.set('theme', t);
  }
  setTheme(store.get('theme', 'felt'));
  themeBtn.addEventListener('click', function () {
    setTheme(document.documentElement.dataset.theme === 'felt' ? 'marble' : 'felt');
  });

  /* ══════════════════════════════════════════════════════
     I · 牌局擂台
     ══════════════════════════════════════════════════════ */
  var felt = $('#card-felt');
  var exprView = $('#expr-view');
  var usedEl = $('#cards-used');
  var valueEl = $('#live-value');
  var flagEl = $('#live-flag');
  var verdictEl = $('#arena-verdict');
  var revealWrap = $('#reveal-wrap');
  var ideaList = $('#idea-list');
  var handIdEl = $('#hand-id');
  var targetChip = $('#target-chip');
  var ideaChip = $('#idea-count-chip');
  var flavourNote = $('#flavour-note');

  var FLAVOUR = {
    easy: '发牌偏向思路多、不需要分数中间值的牌面。',
    normal: '纯随机，只要保证有解。',
    hard: '刁钻：所有解法都必须借助分数中间值，例如 5×(5−1÷5)。'
  };

  var arena = {
    rng: null,
    cards: [], // {v, suit, spent}
    tokens: [],
    flavour: store.get('flavour', 'normal'),
    seed: 0,
    startedAt: 0,
    timerId: null,
    revealed: false,
    solved: false,

    deal: function () {
      var r = currentRange();
      this.seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
      this.rng = E.makeRng(this.seed);
      var dealt = E.dealSolvable(this.rng, {
        minCard: r.min,
        maxCard: r.max,
        flavour: this.flavour,
        target: TARGET
      });
      this.cards = dealt.hand.map(function (v) {
        return { v: v, suit: E.SUITS[Math.floor(Math.random() * 4)], spent: false };
      });
      this.tokens = [];
      this.revealed = false;
      this.solved = false;
      this.handRewarded = false;
      handIdEl.textContent = '局号 ' + handCode(this.seed);
      targetChip.textContent = String(TARGET);
      ideaChip.hidden = false;
      ideaChip.querySelector('b').textContent = String(dealt.result.total);
      this.result = dealt.result;
      revealWrap.hidden = true;
      ideaList.innerHTML = '';
      verdictEl.className = 'verdict';
      verdictEl.textContent = '尚未分出结果。';
      this.render();
      this.startClock();
      $('#foot-seed').textContent = '本局随机种子 ' + this.seed;
      stats.bump('plays');
    },

    reset: function () {
      this.cards.forEach(function (c) {
        c.spent = false;
      });
      this.tokens = [];
      this.solved = false;
      this.revealed = false;
      revealWrap.hidden = true;
      verdictEl.className = 'verdict';
      verdictEl.textContent = '尚未分出结果。';
      this.render();
      this.startClock();
    },

    startClock: function () {
      this.startedAt = Date.now();
      clearInterval(this.timerId);
      var out = $('#cur-time');
      this.timerId = setInterval(function () {
        out.textContent = fmtTime(Date.now() - arena.startedAt);
      }, 250);
      out.textContent = '0:00';
    },
    stopClock: function () {
      clearInterval(this.timerId);
      return Date.now() - this.startedAt;
    },

    render: function () {
      var html = this.cards.map(function (c, i) {
        var label = faceName(c.v);
        return '<button type="button" class="pcard' + (isRed(c.suit) ? ' red' : '') + (c.spent ? ' is-spent' : '') + ' is-dealt"' +
          ' data-i="' + i + '" data-v="' + c.v + '" aria-label="第 ' + (i + 1) + ' 张牌：' + c.v + (c.spent ? '，已使用' : '，点击出牌') + '">' +
          '<span class="corner corner-tl"><span class="r">' + label + '</span><span class="s">' + c.suit + '</span></span>' +
          '<span class="pip">' + c.suit + altHint(c.v) + '</span>' +
          '<span class="corner corner-br"><span class="r">' + label + '</span><span class="s">' + c.suit + '</span></span>' +
          '<span class="idx">' + (i + 1) + '</span>' +
          '</button>';
      }).join('');
      felt.innerHTML = html;
      this.renderExpr();
      this.judge();
    },

    renderExpr: function () {
      if (!this.tokens.length) {
        exprView.innerHTML = '<span class="placeholder">点击上面的牌开始拼装算式</span><span class="caret"></span>';
        return;
      }
      var html = this.tokens.map(function (t) {
        if (t.t === 'n') return '<span class="tok">' + t.v + '</span>';
        if (t.t === 'o') return '<span class="tok tok-op">' + (t.v === '*' ? '×' : t.v === '/' ? '÷' : t.v === '-' ? '−' : '+') + '</span>';
        return '<span class="tok tok-br">' + (t.t === '(' ? '(' : ')') + '</span>';
      }).join('');
      exprView.innerHTML = html + '<span class="caret"></span>';
    },

    pushCard: function (i) {
      var c = this.cards[i];
      if (!c || c.spent) {
        if (c) toast('这张牌已经用过了');
        return;
      }
      c.spent = true;
      this.tokens.push({ t: 'n', v: c.v, slot: i });
      this.afterChange();
    },
    pushOp: function (v) {
      this.tokens.push({ t: 'o', v: v });
      this.afterChange();
    },
    pushParen: function (which) {
      this.tokens.push({ t: which });
      this.afterChange();
    },
    backspace: function () {
      var t = this.tokens.pop();
      if (t && t.t === 'n' && t.slot !== undefined) this.cards[t.slot].spent = false;
      this.afterChange();
    },
    clearAll: function () {
      this.cards.forEach(function (c) {
        c.spent = false;
      });
      this.tokens = [];
      this.afterChange();
    },
    afterChange: function () {
      this.solved = false;
      this.render();
    },

    /* live evaluation + verdict */
    judge: function () {
      var hand = this.cards.map(function (c) {
        return c.v;
      });
      if (!this.tokens.length) {
        usedEl.textContent = '0';
        valueEl.textContent = '—';
        flagEl.className = 'meter-flag';
        flagEl.textContent = '';
        if (!this.solved) {
          verdictEl.className = 'verdict';
          verdictEl.textContent = '点牌出牌，或用键盘 1–4 / + − × ÷ / ( )；Enter 看打法，N 换一局。';
        }
        return;
      }
      var res = E.evaluateTokens(this.tokens, hand, TARGET);
      if (!res.ok) {
        usedEl.textContent = String(this.tokens.filter(function (t) {
          return t.t === 'n';
        }).length);
        valueEl.textContent = '—';
        flagEl.className = 'meter-flag bad';
        flagEl.textContent = res.error;
        if (!this.solved) {
          verdictEl.className = 'verdict';
          verdictEl.textContent = res.error + '。';
        }
        return;
      }
      usedEl.textContent = String(res.numbersUsed);
      valueEl.textContent = res.valueText;
      var spare = hand.length - res.numbersUsed;
      if (res.surplus) {
        flagEl.className = 'meter-flag bad';
        flagEl.textContent = res.usageError;
      } else if (res.hit && res.complete) {
        flagEl.className = 'meter-flag';
        flagEl.textContent = '';
        this.win(res);
        return;
      } else if (res.hit && !res.complete) {
        flagEl.className = 'meter-flag warn';
        flagEl.textContent = res.usageError;
        verdictEl.className = 'verdict lose';
        verdictEl.innerHTML = '算式确实等于 <b>' + TARGET + '</b>，但' + res.usageError +
          '<span class="echo">' + res.expression + ' = ' + TARGET + '</span>';
      } else if (spare > 0) {
        flagEl.className = 'meter-flag warn';
        flagEl.textContent = '还差 ' + spare + ' 张牌';
        verdictEl.className = 'verdict';
        verdictEl.innerHTML = '当前算到 <b>' + res.valueText + '</b>，牌还没出完。' +
          '<span class="echo">' + res.expression + '</span>';
      } else {
        flagEl.className = 'meter-flag warn';
        flagEl.textContent = '差 ' + res.gapText + (res.gapBelow ? '（不足）' : '（超出）');
        verdictEl.className = 'verdict lose';
        verdictEl.innerHTML = '四张牌都用上了，但算到的是 <b>' + res.valueText + '</b>，离 ' + TARGET + ' 还差 <b>' + res.gapText + '</b>。' +
          '<span class="echo">' + res.expression + '</span>';
      }
    },

    win: function (res) {
      if (this.solved) return;
      this.solved = true;
      var ms = this.stopClock();
      $('#cur-time').textContent = fmtTime(ms);
      if (!this.handRewarded) {
        this.handRewarded = true; // one reward per dealt hand, even if re-solved after edits
        stats.win(ms, this.revealed);
      }
      verdictEl.className = 'verdict win';
      verdictEl.innerHTML = '通关！用时 <b>' + fmtTime(ms) + '</b>' + (this.revealed ? '（参考过打法）' : '（独立解出）') +
        '<span class="echo">' + res.expression + ' = ' + TARGET + '</span>';
      toast(this.revealed ? '完成本局' : '漂亮，独立解出');
      felt.querySelectorAll('.pcard').forEach(function (c) {
        c.style.filter = 'none';
      });
    },

    reveal: function () {
      if (!this.result) this.deal();
      this.revealed = true;
      stats.bump('hints');
      revealWrap.hidden = false;
      ideaList.innerHTML = this.result.solutions.map(function (g, i) {
        var fracTag = '<span class="idea-frac ' + (g.fractionUsed ? 'yes' : 'no') + '">' +
          (g.fractionUsed ? '需要分数中间值' : '纯整数运算') + '</span>';
        var alt = '';
        if (g.variants.length) {
          alt = '<div class="idea-alt">' +
            '<button class="disclose" type="button" aria-expanded="false">另有 ' + g.variants.length + ' 种写法</button>' +
            '<div class="variants">' + g.variants.map(function (v) {
              return '<code>' + v + '</code>';
            }).join('') + '</div>' +
            '</div>';
        }
        return '<li>' +
          '<span class="idea-no">打法 ' + (i + 1) + '</span>' +
          '<span class="idea-expr">' + g.display + '</span>' +
          fracTag + alt +
          '</li>';
      }).join('');
      revealWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  ideaList.addEventListener('click', function (ev) {
    var b = ev.target.closest('.disclose');
    if (!b) return;
    var li = b.closest('li');
    var open = li.classList.toggle('open');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.textContent = open ? '收起同义写法' : '另有 ' + (li.querySelectorAll('.variants code').length) + ' 种写法';
  });

  felt.addEventListener('click', function (ev) {
    var b = ev.target.closest('.pcard');
    if (!b) return;
    arena.pushCard(Number(b.dataset.i));
  });

  $('.keypad').addEventListener('click', function (ev) {
    var b = ev.target.closest('.key');
    if (!b) return;
    var k = b.dataset.key;
    if (k === 'back') arena.backspace();
    else if (k === 'clear') arena.clearAll();
    else if (k === '(' || k === ')') arena.pushParen(k);
    else arena.pushOp(k);
  });

  $('#btn-reveal').addEventListener('click', function () {
    arena.reveal();
  });
  $('#btn-replay').addEventListener('click', function () {
    arena.reset();
    toast('牌面已复位，重新摆算式');
  });
  $('#btn-deal').addEventListener('click', function () {
    arena.deal();
  });
  $('#btn-copy-reveal').addEventListener('click', function () {
    if (!arena.result) return;
    var txt = arena.result.solutions.map(function (g, i) {
      return (i + 1) + '. ' + g.display + (g.variants.length ? '\n    其他写法：' + g.variants.map(function (v) {
        return v.replace(/ =.*$/, '');
      }).join('，') : '');
    }).join('\n');
    copyText('廿四牌局 ' + handCode(arena.seed) + '　牌面 ' + arena.cards.map(function (c) {
      return c.v;
    }).join(', ') + '\n' + txt, '打法清单已复制');
  });

  $('#flavour-group').addEventListener('click', function (ev) {
    var b = ev.target.closest('.seg');
    if (!b) return;
    $$('.seg', this).forEach(function (s) {
      var on = s === b;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    arena.flavour = b.dataset.flavour;
    flavourNote.textContent = FLAVOUR[arena.flavour];
    store.set('flavour', arena.flavour);
    arena.deal();
  });

  /* keyboard: 1–4 select card by position, operators and brackets typed directly */
  document.addEventListener('keydown', function (ev) {
    if (!$('#panel-arena').classList.contains('is-active')) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var k = ev.key;
    if (/^[1-4]$/.test(k)) {
      arena.pushCard(Number(k) - 1);
      ev.preventDefault();
    } else if (k === '+' || k === '-' || k === '*' || k === '/') {
      arena.pushOp(k);
      ev.preventDefault();
    } else if (k === '(' || k === ')') {
      arena.pushParen(k);
      ev.preventDefault();
    } else if (k === 'Backspace') {
      arena.backspace();
      ev.preventDefault();
    } else if (k === 'Enter') {
      arena.reveal();
      ev.preventDefault();
    } else if (k === 'Escape') {
      arena.clearAll();
      ev.preventDefault();
    } else if (k === 'n' || k === 'N') {
      arena.deal();
      ev.preventDefault();
    }
  });

  /* ── stats ───────────────────────────────────────────── */
  var stats = {
    s: store.get('stats', { plays: 0, wins: 0, streak: 0, best: 0, hints: 0, fastest: null }),
    bump: function (key) {
      this.s[key] = (this.s[key] || 0) + 1;
      this.save();
    },
    win: function (ms, revealed) {
      this.s.wins = (this.s.wins || 0) + 1;
      if (!revealed) {
        this.s.streak = (this.s.streak || 0) + 1;
        this.s.best = Math.max(this.s.best || 0, this.s.streak);
        if (this.s.fastest === null || this.s.fastest === undefined || ms < this.s.fastest) this.s.fastest = ms;
      } else {
        this.s.streak = 0;
      }
      this.save();
    },
    reset: function () {
      this.s = { plays: 0, wins: 0, streak: 0, best: 0, hints: 0, fastest: null };
      this.save();
      toast('战绩已清空');
    },
    save: function () {
      store.set('stats', this.s);
      this.render();
    },
    render: function () {
      $('#st-cur').textContent = String(this.s.streak || 0);
      $('#st-best').textContent = String(this.s.best || 0);
      $('#st-rate').textContent = (this.s.wins || 0) + ' / ' + (this.s.plays || 0);
      $('#st-fastest').textContent = this.s.fastest ? fmtTime(this.s.fastest) : '—';
      $('#st-hints').textContent = String(this.s.hints || 0);
    }
  };
  $('#btn-reset-stats').addEventListener('click', function () {
    stats.reset();
  });
  stats.render();

  /* ══════════════════════════════════════════════════════
     II · 解法审计
     ══════════════════════════════════════════════════════ */
  var slotsWrap = $('#audit-slots');
  var report = $('#audit-report');
  var auditTarget = $('#audit-target');

  slotsWrap.innerHTML = [0, 1, 2, 3].map(function (i) {
    return '<span class="slot"><input type="number" min="1" max="99" step="1" inputmode="numeric" ' +
      'placeholder="' + (i + 1) + '" aria-label="第 ' + (i + 1) + ' 张牌"><span class="slot-tag">牌 ' + (i + 1) + '</span></span>';
  }).join('');
  var slotInputs = $$('input', slotsWrap);

  function readAudit() {
    var nums = [];
    var bad = [];
    var reason = null;
    slotInputs.forEach(function (inp) {
      var v = inp.value.trim();
      inp.classList.remove('bad');
      if (!/^\d+$/.test(v)) {
        bad.push(inp);
        inp.classList.add('bad');
        reason = reason || '四张牌都要填成整数';
        return;
      }
      var n = Number(v);
      if (n < 1) {
        bad.push(inp);
        inp.classList.add('bad');
        reason = reason || '牌面至少是 1';
        return;
      }
      if (n > 99) {
        bad.push(inp);
        inp.classList.add('bad');
        reason = reason || '牌面最大支持 99';
        return;
      }
      nums.push(n);
    });
    return { nums: nums, bad: bad, ready: nums.length === 4 && !bad.length, reason: reason };
  }

  function renderAudit(nums, target) {
    var res = E.solve(nums, target);
    var head = '<div class="report-card">' +
      '<h3 class="report-title">牌面 ' + nums.join(' · ') + '　目标 ' + target + '</h3>';
    var banner, methods;

    if (!res.total) {
      var ap = E.bestApprox(nums, target);
      banner = '<div class="verdict-banner dead">' +
        '<span class="big">无解</span>' +
        '<span>已穷尽 ' + E.countPaths(nums.length) + ' 条配对/运算/结合顺序的推导路径，没有任何算式等于 ' + target + '。</span>' +
        (ap ? '<span class="near">最接近：<code>' + ap.display + '</code>，差 ' + ap.diffText + (ap.below ? '（不足）' : '（超出）') + '</span>' : '') +
        '</div>';
      methods = '';
    } else {
      var fracCount = res.solutions.filter(function (g) {
        return g.fractionUsed;
      }).length;
      banner = '<div class="verdict-banner go">' +
        '<span class="big">' + res.total + ' 种思路</span>' +
        '<span>结构等价与 ×1 / ÷1 / +0 之类的书写变体已折叠' +
        (res.rawTotal !== res.total ? '，共合并 ' + (res.rawTotal - res.total) + ' 条同义写法' : '') + '。</span>' +
        (fracCount ? '<span class="m-frac">' + fracCount + ' 种需要分数中间值</span>' : '') +
        '</div>';
      methods = '<div class="method-grid">' + res.solutions.map(function (g, i) {
        return '<div class="method">' +
          '<span class="m-expr">' + (i + 1) + '. ' + g.display + '</span>' +
          (g.fractionUsed ? '<span class="m-frac">分数</span>' : '') +
          (g.variants.length ? '<span class="m-alt">+' + g.variants.length + ' 种写法</span>' : '') +
          '</div>';
      }).join('') + '</div>';
    }

    var copyBtn = '<button class="btn btn-sm" type="button" id="audit-copy">复制全部算式</button>';
    var linkBtn = '<button class="btn btn-sm" type="button" id="audit-link">复制题目链接</button>';
    var expandBtn = res.total && res.rawTotal > res.total
      ? '<button class="btn btn-sm" type="button" id="audit-expand">展开全部 ' + res.rawTotal + ' 条原始算式</button>'
      : '';
    var foot = '<div class="audit-foot">' + copyBtn + linkBtn + expandBtn +
      '<span>搜索 ' + E.countPaths(nums.length) + ' 条路径 · 折叠后 ' + res.total +
      ' 种思路 / ' + res.rawTotal + ' 条原始算式 · BigInt 精确分数</span></div>';

    report.innerHTML = head + banner + methods + foot + '</div>';
    wireReport(res, nums, target);
  }

  function wireReport(res, nums, target) {
    var link = $('#audit-link');
    if (link) link.addEventListener('click', function () {
      var url = location.origin === 'null' || !/^https?:/.test(location.protocol)
        ? 'index.html?audit=' + nums.join(',') + '&target=' + target
        : location.origin + location.pathname + '?audit=' + nums.join(',') + '&target=' + target;
      copyText(url, '题目链接已复制，对方打开即直达本结果');
    });
    var copy = $('#audit-copy');
    if (copy) copy.addEventListener('click', function () {
      var txt = res.solutions.length
        ? res.solutions.map(function (g, i) {
            return (i + 1) + '. ' + g.display;
          }).join('\n')
        : '牌面 ' + nums.join(', ') + '（目标 ' + target + '）：无解';
      copyText(txt, '算式已复制');
    });
    var exp = $('#audit-expand');
    if (exp) exp.addEventListener('click', function () {
      report.innerHTML = '<div class="report-card dark">' +
        '<h3 class="report-title">原始算式全表（含书写变体）</h3>' +
        '<p class="report-meta">牌面 ' + nums.join(' · ') + '，目标 ' + target + '，共 ' + res.rawTotal + ' 条。</p>' +
        '<div class="method-grid">' + res.raw.map(function (s, i) {
          return '<div class="method"><span class="m-expr">' + (i + 1) + '. ' + s.display + '</span>' +
            (s.fractionUsed ? '<span class="m-frac">分数</span>' : '') + '</div>';
        }).join('') + '</div>' +
        '<div class="audit-foot"><button class="btn btn-sm" type="button" id="audit-back">← 回到折叠视图</button></div>' +
        '</div>';
      $('#audit-back').addEventListener('click', function () {
        renderAudit(nums, target);
      });
    });
  }

  $('#audit-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var st = readAudit();
    if (!st.ready) {
      report.innerHTML = '<p class="err-note">' + (st.reason || '请填齐四个正整数') + '，牌面范围 1–99。</p>';
      if (st.bad[0]) st.bad[0].focus();
      return;
    }
    var t = Math.max(1, Math.min(999, Number(auditTarget.value) || TARGET));
    auditTarget.value = String(t);
    renderAudit(st.nums, t);
  });

  function fillAudit(pick) {
    var r = currentRange();
    var rng = E.makeRng((Date.now() ^ pick.length * 2654435761) >>> 0);
    var hand = pick === 'live'
      ? E.dealSolvable(rng, { minCard: r.min, maxCard: r.max, flavour: 'normal' }).hand
      : E.dealUnsolvable(rng, { minCard: r.min, maxCard: r.max }).hand;
    slotInputs.forEach(function (inp, i) {
      inp.value = String(hand[i]);
    });
    renderAudit(hand, Math.max(1, Number(auditTarget.value) || TARGET));
    toast(pick === 'live' ? '已填入一手有解牌组' : '已填入一手死局');
  }
  $('#audit-fill-live').addEventListener('click', function () {
    fillAudit('live');
  });
  $('#audit-fill-dead').addEventListener('click', function () {
    fillAudit('dead');
  });
  $('#audit-clear').addEventListener('click', function () {
    slotInputs.forEach(function (inp) {
      inp.value = '';
    });
    auditTarget.value = String(TARGET);
    report.innerHTML = '<p class="muted">等待输入。</p>';
    slotInputs[0].focus();
  });

  /* ══════════════════════════════════════════════════════
     III · 死局牌库
     ══════════════════════════════════════════════════════ */
  var deckGrid = $('#deck-grid');
  var batch = store.get('batch', 5);
  var minted = [];

  function setBatchUI() {
    $$('#batch-group .seg').forEach(function (s) {
      var on = Number(s.dataset.batch) === batch;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  setBatchUI();
  $('#batch-group').addEventListener('click', function (ev) {
    var b = ev.target.closest('.seg');
    if (!b) return;
    batch = Number(b.dataset.batch);
    store.set('batch', batch);
    setBatchUI();
    mint();
  });

  function miniCard(v) {
    var suit = E.SUITS[Math.floor(Math.random() * 4)];
    return '<span class="mini' + (isRed(suit) ? ' red' : '') + '">' + faceName(v) +
      '<span class="s">' + suit + '</span></span>';
  }

  function mint() {
    var rangeKey = currentRange().key;
    var data = D.ranges[rangeKey];
    var pool;
    if (data && data.deadHands && data.deadHands.length) {
      pool = data.deadHands;
    } else {
      // fall back to live search if data.js is missing
      pool = [];
      var r = currentRange();
      for (var a = r.min; a <= r.max; a++)
        for (var b = a; b <= r.max; b++)
          for (var c = b; c <= r.max; c++)
            for (var d = c; d <= r.max; d++) {
              var h = [a, b, c, d];
              if (E.isUnsolvable(h, TARGET)) pool.push(h);
            }
    }
    var picked = [];
    var guard = 0;
    while (picked.length < Math.min(batch, pool.length) && guard < batch * 60) {
      guard++;
      var cand = pool[Math.floor(Math.random() * pool.length)];
      var key = cand.join(',');
      if (picked.some(function (p) {
        return p.key === key;
      })) continue;
      picked.push({ key: key, hand: cand.slice() });
    }
    minted = picked.map(function (p, i) {
      var ap = E.bestApprox(p.hand, TARGET);
      return {
        hand: p.hand,
        id: handCode((i * 7919 + p.hand.join('').length * 31 + Date.now()) >>> 0),
        ap: ap
      };
    });
    deckGrid.innerHTML = minted.length
      ? minted.map(function (m) {
          return '<div class="deck-card">' +
            '<div class="dc-head"><span class="dc-hand">' + m.hand.map(miniCard).join('') + '</span>' +
            '<span class="dc-id">' + m.id + '</span></div>' +
            '<p class="dc-note">' + m.hand.map(faceName).join(' ') + ' · 已穷尽 ' + E.countPaths(4) + ' 条推导路径，无一等于 ' + TARGET + '。' +
            (m.ap ? '最接近的尝试算到 <b>' + m.ap.valueText + '</b>（差 <b>' + m.ap.diffText + '</b>' + (m.ap.below ? '，不足' : '，超出') + '）：<br>' + m.ap.display : '') +
            '</p>' +
            '<button class="dc-audit" type="button" data-hand="' + m.hand.join(',') + '">送进解法审计复核</button>' +
            '</div>';
        }).join('')
      : '<p class="err-note">该范围内找不到死局牌组，请换一种牌面范围。</p>';
  }

  deckGrid.addEventListener('click', function (ev) {
    var b = ev.target.closest('.dc-audit');
    if (!b) return;
    var nums = b.dataset.hand.split(',').map(Number);
    slotInputs.forEach(function (inp, i) {
      inp.value = String(nums[i]);
    });
    auditTarget.value = String(TARGET);
    renderAudit(nums, TARGET);
    showPanel('audit');
    toast('已在解法审计中复核该牌组');
  });

  $('#btn-mint').addEventListener('click', function () {
    mint();
    toast('已铸 ' + minted.length + ' 组死局');
  });
  $('#btn-copy-deck').addEventListener('click', function () {
    if (!minted.length) {
      toast('先生成一组死局');
      return;
    }
    var txt = '廿四牌局 · 死局牌库（目标 ' + TARGET + '，牌面 ' + currentRange().key + '）\n' +
      minted.map(function (m, i) {
        return (i + 1) + '. ' + m.hand.join(' ') + (m.ap ? '　最接近 ' + m.ap.valueText + '（差 ' + m.ap.diffText + '）' : '');
      }).join('\n');
    copyText(txt, '死局牌组已复制');
  });

  /* ── landscape (from data.js) ────────────────────────── */
  var landGrid = $('#land-grid');
  var nearList = $('#near-list');
  var landscape = {
    render: function () {
      var d = D.ranges && D.ranges[currentRange().key];
      if (!d) {
        landGrid.innerHTML = '<p class="err-note">缺少预计算数据，请运行 node scripts/build-data.js。</p>';
        nearList.innerHTML = '';
        return;
      }
      var cards = [
        { v: d.combos, k: '全部牌组（不计顺序）' },
        { v: d.dead, k: '死局牌组', bar: d.deadRate },
        { v: (d.deadRate * 100).toFixed(1) + '%', k: '随机发牌踩到死局的概率' },
        { v: d.richest.ideas, k: '思路最多的牌组 ' + d.richest.hand.join(' · ') },
        { v: d.fractionOnlyHands, k: '必须用分数中间值才有解' },
        { v: d.solvable, k: '至少有一种打法的牌组' }
      ];
      landGrid.innerHTML = cards.map(function (c) {
        return '<div class="land"><div class="v">' + c.v + '</div><div class="k">' + c.k + '</div>' +
          (c.bar !== undefined ? '<div class="bar"><i style="width:' + Math.round(c.bar * 100) + '%"></i></div>' : '') +
          '</div>';
      }).join('');

      var hist = Object.keys(d.histogram).map(Number).sort(function (a, b) {
        return a - b;
      });
      var maxV = Math.max.apply(null, hist.map(function (n) {
        return d.histogram[n];
      }));
      nearList.innerHTML = d.nearMisses.map(function (m) {
        return '<div class="near-row" data-hand="' + m.hand.join(',') + '">' +
          m.hand.map(function (v) {
            return faceName(v);
          }).join(' ') +
          '<span class="gap">差 ' + m.diff + '</span></div>';
      }).join('') +
        '<div class="side-note">思路分布：' + hist.slice(0, 12).map(function (n) {
          return n + ' 种 → ' + d.histogram[n] + ' 组';
        }).join(' · ') + (hist.length > 12 ? ' …' : '') +
        '（占比最高 ' + Math.round((maxV / d.combos) * 100) + '%）</div>';
    }
  };

  nearList.addEventListener('click', function (ev) {
    var row = ev.target.closest('.near-row');
    if (!row) return;
    var nums = row.dataset.hand.split(',').map(Number);
    slotInputs.forEach(function (inp, i) {
      inp.value = String(nums[i]);
    });
    renderAudit(nums, TARGET);
    showPanel('audit');
    toast('已送入解法审计：' + nums.join(' · '));
  });

  /* ══════════════════════════════════════════════════════
     boot
     ══════════════════════════════════════════════════════ */
  flavourNote.textContent = FLAVOUR[arena.flavour];
  $$('#flavour-group .seg').forEach(function (s) {
    var on = s.dataset.flavour === arena.flavour;
    s.classList.toggle('is-active', on);
    s.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  /* shareable link:  ?audit=1,5,5,5&target=24  → opens straight into 解法审计 */
  function fromQuery() {
    var q = new URLSearchParams(location.search);
    var raw = q.get('audit');
    if (!raw) return false;
    var nums = raw.split(/[^0-9]+/).filter(Boolean).map(Number).slice(0, 4);
    if (nums.length !== 4) return false;
    slotInputs.forEach(function (inp, i) {
      inp.value = String(nums[i]);
    });
    var t = Number(q.get('target')) || TARGET;
    auditTarget.value = String(Math.max(1, Math.min(999, t)));
    renderAudit(nums, auditTarget.valueAsNumber);
    showPanel(q.get('panel') === 'arena' || q.get('panel') === 'deck' ? q.get('panel') : 'audit');
    return true;
  }

  if (!fromQuery()) {
    var hash = (location.hash || '#arena').slice(1);
    showPanel(['arena', 'audit', 'deck'].indexOf(hash) >= 0 ? hash : 'arena');
  }
  arena.deal();
  mint();
  landscape.render();

  window.addEventListener('hashchange', function () {
    var h = (location.hash || '#arena').slice(1);
    if (['arena', 'audit', 'deck'].indexOf(h) >= 0) showPanel(h);
  });
})();

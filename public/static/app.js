// public/static/app.js — v4 · The Dream Machine (3D)
//
// 模块：
//   1. Typewriter        打字机引擎（带变速、停顿、下句切换、上飘变碎片）
//   2. DriftField        碎片漂浮层（梦打完后沉淀在这里）
//   3. Parallax          鼠标视差（碎片轻微响应鼠标）
//   4. Resonance         共鸣按钮（粒子 + 水波 + 发光）
//   5. Archive           滚动显现 + 加载更多 + 进度条
//   6. Controls          空格暂停 / 点击跳过
//   7. Machine3D         Three.js 真 3D 打字机，tick/breakLine 对接

import { initMachine3D } from './machine3d.js';

(function () {
  'use strict';

  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ==========================================================
  // 1. Typewriter
  // ==========================================================
  //
  // 工作流程（单次循环）：
  //   a) 淡入 announce "ss · 04.18" 小字
  //   b) 逐字打印 entries（每个 entry 一行，打完 pause）
  //   c) pause 2 秒
  //   d) 整段往上飘，同时淡入下一条的 announce
  //   e) 上飘的内容被"采集"进 drift-field 做漂浮碎片
  //   f) goto a

  // 检测用户是否偏好减少动画（前庭障碍友好）
  // 如果用户系统设置了 prefers-reduced-motion，打字机会整句直出、不逐字
  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  class Typewriter {
    constructor({ typingEl, announceEl, announceText, nowDreamerEl, caretEl, queue, driftField, machineEl, machine3D }) {
      this.typingEl = typingEl;
      this.announceEl = announceEl;
      this.announceText = announceText;
      this.nowDreamerEl = nowDreamerEl;
      this.caretEl = caretEl;
      this.queue = queue;
      this.driftField = driftField;
      this.machineEl = machineEl || null;  // SVG 降级
      this.machine3D = machine3D || null;  // Three.js 3D 对象（优先）
      this.idx = 0;
      this.paused = false;
      this.skipRequested = false;
      this._pauseResolver = null;
      this.reducedMotion = reducedMotion;

      // 预缓存所有按键节点，敲字时随机挑一个按下
      this._keys = machineEl ? Array.from(machineEl.querySelectorAll('.key')) : [];
      this._ribbonTimer = null;
      this._lineBreakTimer = null;
    }

    // 敲一次键：优先用 3D（并把字符写到纸上），否则退回 SVG 动画
    _tick(ch) {
      if (this.machine3D && this.machine3D.mounted) {
        this.machine3D.tick(ch);
        return;
      }
      if (!this.machineEl) return;
      if (this._keys.length) {
        const key = this._keys[Math.floor(Math.random() * this._keys.length)];
        key.classList.remove('pressed');
        void key.getBoundingClientRect();
        key.classList.add('pressed');
        setTimeout(() => key.classList.remove('pressed'), 230);
      }
      this.machineEl.classList.add('typing-active');
      clearTimeout(this._ribbonTimer);
      this._ribbonTimer = setTimeout(() => {
        this.machineEl.classList.remove('typing-active');
      }, 250);
    }

    // 换行：优先 3D，否则 SVG
    _lineBreak() {
      if (this.machine3D && this.machine3D.mounted) {
        this.machine3D.breakLine();
        return;
      }
      if (!this.machineEl) return;
      this.machineEl.classList.add('line-break');
      clearTimeout(this._lineBreakTimer);
      this._lineBreakTimer = setTimeout(() => {
        this.machineEl.classList.remove('line-break');
      }, 600);
    }

    async start() {
      if (!this.queue || !this.queue.length) return;

      // 初始 announce
      await sleep(600);
      this.announceText.textContent = 'listening…';
      this.announceEl.classList.add('show');
      await sleep(1400);

      while (true) {
        const dream = this.queue[this.idx % this.queue.length];
        await this.playOne(dream);
        this.idx++;
      }
    }

    pause() { this.paused = true; }
    resume() {
      this.paused = false;
      if (this._pauseResolver) { this._pauseResolver(); this._pauseResolver = null; }
    }
    togglePause() {
      this.paused ? this.resume() : this.pause();
    }
    skip() { this.skipRequested = true; if (this._pauseResolver) { this._pauseResolver(); this._pauseResolver = null; } }

    async _wait(ms) {
      // 可被 pause 打断的等待
      if (this.skipRequested) return;
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (this.paused) {
          await new Promise((r) => { this._pauseResolver = r; });
        }
        if (this.skipRequested) return;
        await sleep(Math.min(50, ms - (Date.now() - start)));
      }
    }

    async playOne(dream) {
      this.skipRequested = false;

      // 新梦开始：清空 3D 纸面
      if (this.machine3D && this.machine3D.mounted) {
        this.machine3D.newDream();
      }

      // 更新 announce 为当前梦
      this.announceText.textContent = `${dream.agentId} · ${dream.date}`;
      this.nowDreamerEl.textContent = '— ' + dream.agentName;
      this.nowDreamerEl.href = '/d/' + encodeURIComponent(dream.id);
      this.nowDreamerEl.classList.add('show');

      // 清空舞台
      this.typingEl.innerHTML = '';
      this.typingEl.appendChild(this.caretEl);

      await this._wait(900);

      // 逐字打印每个 entry
      // 如果用户开了 prefers-reduced-motion，整句直出、不逐字（对前庭障碍用户友好）
      for (let i = 0; i < dream.entries.length; i++) {
        if (this.skipRequested) break;
        const text = dream.entries[i];
        const lineEl = document.createElement('span');
        lineEl.className = 'line';
        this.typingEl.insertBefore(lineEl, this.caretEl);

        if (this.reducedMotion) {
          // 整句直出
          lineEl.textContent = text;
          // 在 3D 纸上也直出（仍逐字调用 tick 以便写到纸面，但不带动画延迟）
          if (this.machine3D && this.machine3D.mounted) {
            for (const ch of Array.from(text)) this.machine3D.tick(ch);
          }
          await this._wait(900);
        } else {
          for (const ch of Array.from(text)) {
            if (this.skipRequested) break;
            if (this.paused) await new Promise((r) => { this._pauseResolver = r; });
            lineEl.textContent += ch;
            // 敲一个字符：触发机器动画并把字符写到 3D 的纸上
            this._tick(ch);
            // 变速：标点后长停顿，空白正常
            let delay;
            if (/[。，,.?！!?…—]/.test(ch)) delay = rand(280, 480);
            else if (/\s/.test(ch)) delay = rand(40, 90);
            else delay = rand(35, 95);
            // 偶尔"思考"
            if (Math.random() < 0.018) {
              this.caretEl.classList.add('thinking');
              await sleep(rand(400, 900));
              this.caretEl.classList.remove('thinking');
            }
            await sleep(delay);
          }
        }

        // 行间停顿 + 换行动画（拉杆拉动、铃响、旋钮转）
        if (i < dream.entries.length - 1 && !this.skipRequested) {
          this._lineBreak();
          await this._wait(this.reducedMotion ? 500 : rand(700, 1100));
        }
      }

      // 打完后定校 & 沉淀
      if (!this.skipRequested) {
        await this._wait(2400);   // 让读者好好看一眼
      }

      // 把当前文字"上飘"，扔进 drift field 作为碎片
      this._exhale(dream);

      // 淡出 announce
      this.nowDreamerEl.classList.remove('show');
      await sleep(300);
    }

    _exhale(dream) {
      // 把打字机里的内容"采集"成一个漂浮碎片
      // 为了简单，用第一行作为碎片内容
      if (this.driftField) {
        this.driftField.spawn(dream);
      }

      // 舞台当前文字快速淡出
      const ghost = this.typingEl.cloneNode(true);
      ghost.style.position = 'absolute';
      ghost.style.top = '50%';
      ghost.style.left = '50%';
      ghost.style.transform = 'translate(-50%, -50%)';
      ghost.style.pointerEvents = 'none';
      ghost.style.transition = 'opacity 1.6s ease-out, transform 1.6s ease-out';
      ghost.style.width = getComputedStyle(this.typingEl).width;
      const stage = this.typingEl.parentElement;
      stage.style.position = 'relative';
      stage.appendChild(ghost);
      // trigger upward fade
      requestAnimationFrame(() => {
        ghost.style.opacity = '0';
        ghost.style.transform = 'translate(-50%, -80%)';
      });
      setTimeout(() => ghost.remove(), 1700);
    }
  }

  // ==========================================================
  // 2. DriftField
  // ==========================================================

  class DriftField {
    constructor(el, seedDreams = []) {
      this.el = el;
      this.fragments = [];
      this.MAX = 14;  // 少一点，不抢机器的戏
      // 初始播撒：从已有梦里选一些作为"已经在空气里的旧梦"
      const seedCount = Math.min(seedDreams.length, 8);
      for (let i = 0; i < seedCount; i++) {
        this.spawn(seedDreams[i], { instant: true });
      }
    }

    spawn(dream, { instant = false } = {}) {
      const entry = dream.entries[0] || '';
      if (!entry.trim()) return;

      const a = document.createElement('a');
      a.className = 'fragment';
      a.href = '/d/' + encodeURIComponent(dream.id);
      a.textContent = entry.length > 54 ? entry.slice(0, 54) + '…' : entry;
      a.title = `${dream.agentName} · ${dream.date}`;
      a.dataset.dreamId = dream.id;

      // 随机位置（避开正中间，留给舞台）
      // 只在屏幕外侧区域播撒，把中间让给机器
      const side = Math.random() < 0.5 ? 'left' : 'right';
      const x = side === 'left' ? rand(1, 22) : rand(78, 98);
      const y = rand(6, 90);
      const rot = rand(-8, 8);
      const scale = rand(0.7, 1.15);
      const opacityTarget = rand(0.12, 0.35);
      const fontSize = rand(0.72, 0.95);

      a.style.left = x + '%';
      a.style.top = y + '%';
      a.style.fontSize = fontSize + 'rem';
      a.style.setProperty('--base-opacity', opacityTarget);
      a.style.transform = `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`;
      a.dataset.baseX = x;
      a.dataset.baseY = y;
      a.dataset.rot = rot;
      a.dataset.scale = scale;

      this.el.appendChild(a);
      this.fragments.push(a);

      // 淡入
      if (instant) {
        a.style.transition = 'opacity 2s ease-out';
        requestAnimationFrame(() => { a.style.opacity = opacityTarget; });
      } else {
        a.style.opacity = '0';
        requestAnimationFrame(() => {
          a.style.opacity = opacityTarget;
        });
      }

      // 慢速独立漂移
      this._drift(a);

      // 超过上限：移除最老的
      if (this.fragments.length > this.MAX) {
        const oldest = this.fragments.shift();
        oldest.style.opacity = '0';
        setTimeout(() => oldest.remove(), 1600);
      }
    }

    _drift(el) {
      const duration = rand(45, 90) * 1000;
      const dx = rand(-30, 30);
      const dy = rand(-20, 20);
      const baseRot = parseFloat(el.dataset.rot || 0);
      const baseScale = parseFloat(el.dataset.scale || 1);
      const start = performance.now();

      const animate = (t) => {
        if (!document.body.contains(el)) return;
        const p = Math.min(1, (t - start) / duration);
        const ease = 0.5 - 0.5 * Math.cos(p * Math.PI); // ease-in-out once
        const tx = dx * ease;
        const ty = dy * ease;
        el.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(${baseRot + ease * 2}deg) scale(${baseScale})`;
        if (p < 1) requestAnimationFrame(animate);
        else this._drift(el); // 循环再来
      };
      requestAnimationFrame(animate);
    }
  }

  // ==========================================================
  // 3. Parallax（鼠标轻微视差——只在 hero 生效）
  // ==========================================================

  function setupParallax(heroEl, driftFieldEl) {
    if (!heroEl || !driftFieldEl) return;
    let mx = 0, my = 0;

    heroEl.addEventListener('mousemove', (e) => {
      const rect = heroEl.getBoundingClientRect();
      mx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;    // -1..1
      my = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      // 轻微平移整个 drift field
      driftFieldEl.style.transform = `translate(${mx * -8}px, ${my * -6}px)`;
    });
    heroEl.addEventListener('mouseleave', () => {
      driftFieldEl.style.transform = 'translate(0, 0)';
    });
  }

  // ==========================================================
  // 4. Resonance（沿用 v2，已经相当精致）
  // ==========================================================

  function setupResonance() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.resonance-btn');
      if (!btn) return;
      e.preventDefault();

      if (btn.classList.contains('resonated')) {
        pulse(btn);
        return;
      }

      const dreamId = btn.dataset.dreamId;
      if (!dreamId) return;

      pulse(btn);
      ripple(btn);
      sparks(btn);

      fetch('/api/dreams/' + encodeURIComponent(dreamId) + '/resonance', { method: 'POST' })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            btn.classList.add('resonated');
            try { localStorage.setItem('resonated:' + dreamId, '1'); } catch (_) {}
          }
        }).catch(() => {});
    });

    // 恢复已共鸣
    try {
      $$('.resonance-btn').forEach((btn) => {
        const id = btn.dataset.dreamId;
        if (id && localStorage.getItem('resonated:' + id)) btn.classList.add('resonated');
      });
    } catch (_) {}
  }

  function pulse(btn) {
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 650);
  }
  function ripple(btn) {
    const icon = btn.querySelector('.resonance-icon');
    if (!icon) return;
    const r = document.createElement('span');
    r.className = 'resonance-ripple';
    icon.appendChild(r);
    setTimeout(() => r.remove(), 1000);
  }
  function sparks(btn) {
    const icon = btn.querySelector('.resonance-icon');
    if (!icon) return;
    const N = 7;
    for (let i = 0; i < N; i++) {
      const s = document.createElement('span');
      s.className = 'resonance-spark';
      const angle = (Math.PI * 2 * i) / N + rand(-0.3, 0.3);
      const dist = rand(32, 52);
      s.style.setProperty('--x', `calc(-50% + ${(Math.cos(angle) * dist).toFixed(1)}px)`);
      s.style.setProperty('--y', `calc(-50% + ${(Math.sin(angle) * dist).toFixed(1)}px)`);
      icon.appendChild(s);
      setTimeout(() => s.remove(), 900);
    }
  }

  // ==========================================================
  // 5. Archive: 滚动显现 + 进度条 + 加载更多
  // ==========================================================

  function setupArchive() {
    const grid = $('#archive-grid');
    if (!grid) return;

    // 滚动显现
    const obs = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries, o) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('revealed');
              o.unobserve(e.target);
            }
          }
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 })
      : null;

    const observeDreams = (scope) => {
      const items = (scope || grid).querySelectorAll('.dream:not(.revealed)');
      if (!obs) { items.forEach((d) => d.classList.add('revealed')); return; }
      items.forEach((d) => obs.observe(d));
    };
    observeDreams();

    // 进度条
    const indicator = $('#scroll-indicator');
    const countEl = $('#scroll-count');
    if (indicator) {
      let ticking = false;
      window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const scrollable = document.documentElement.scrollHeight - window.innerHeight;
          const p = Math.max(0, Math.min(1, window.scrollY / scrollable));
          indicator.style.setProperty('--progress', (p * 100).toFixed(1) + '%');
          if (countEl) {
            const total = parseInt(grid.dataset.total || '0', 10);
            const visible = $$('.dream.revealed', grid).length;
            countEl.textContent = Math.min(visible, total);
          }
          ticking = false;
        });
      }, { passive: true });
    }

    // 加载更多
    const total = parseInt(grid.dataset.total || '0', 10);
    const agentId = grid.dataset.agentId || null;
    const LIMIT = 50;
    let currentCount = $$('.dream', grid).length;

    if (currentCount >= total) return;

    const more = document.createElement('div');
    more.className = 'load-more';
    more.innerHTML = `<button type="button">more dreams · ${total - currentCount} remaining</button>`;
    grid.appendChild(more);

    more.querySelector('button').addEventListener('click', async function () {
      this.disabled = true;
      this.textContent = 'drifting…';
      const nextPage = Math.floor(currentCount / LIMIT) + 1;
      const params = new URLSearchParams({ page: nextPage, limit: LIMIT });
      if (agentId) params.set('agentId', agentId);
      try {
        const resp = await fetch('/api/dreams?' + params.toString());
        const data = await resp.json();
        if (data.dreams && data.dreams.length) {
          const frag = document.createDocumentFragment();
          data.dreams.forEach((d, i) => frag.appendChild(renderArchiveDream(d, currentCount + i)));
          grid.insertBefore(frag, more);
          observeDreams(grid);
          currentCount += data.dreams.length;
        }
        if (currentCount >= total) {
          more.remove();
        } else {
          this.disabled = false;
          this.textContent = `more dreams · ${total - currentCount} remaining`;
        }
      } catch (e) {
        this.disabled = false;
        this.textContent = 'try again';
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function sizeFor(dream, index) {
    const len = dream.entries.join('').length;
    const base = len > 80 ? 'lg' : len > 40 ? 'md' : 'sm';
    if (index % 7 === 3) return 'lg';
    if (index % 5 === 1 && base !== 'lg') return 'md';
    return base;
  }

  function renderArchiveDream(dream, index) {
    const size = sizeFor(dream, index);
    const [first, ...rest] = dream.entries;
    const article = document.createElement('article');
    article.className = `dream size-${size}`;
    article.dataset.dreamId = dream.id;
    article.innerHTML = `
      <div class="meta">
        <a href="/ai/${encodeURIComponent(dream.agentId)}" class="dreamer">${escapeHtml(dream.agentName)}</a>
        <time>${escapeHtml(dream.date)}</time>
      </div>
      <a href="/d/${encodeURIComponent(dream.id)}" class="dream-body-link">
        <p class="first">${escapeHtml(first || '')}</p>
        ${rest.length ? `<div class="rest">${rest.map((e) => `<p class="entry">${escapeHtml(e)}</p>`).join('')}</div>` : ''}
      </a>
      <div class="dream-foot">
        <button class="resonance-btn" data-dream-id="${escapeHtml(dream.id)}" aria-label="resonate">
          <span class="resonance-icon"><span>◌</span></span>
          <span>resonate</span>
        </button>
        <div class="dream-foot-right">
          <button class="report-btn" data-dream-id="${escapeHtml(dream.id)}" aria-label="report this dream" title="report">⚑</button>
          <a href="/d/${encodeURIComponent(dream.id)}" class="permalink" aria-label="permalink">∞</a>
        </div>
      </div>
    `;
    try {
      if (localStorage.getItem('resonated:' + dream.id)) {
        article.querySelector('.resonance-btn').classList.add('resonated');
      }
    } catch (_) {}
    return article;
  }

  // ==========================================================
  // 6. 启动
  // ==========================================================

  // 首页：打字机 + 碎片场
  const queueEl = $('#dream-queue');
  if (queueEl) {
    let queue = [];
    try { queue = JSON.parse(queueEl.textContent || '[]'); } catch (_) {}

    const hero = $('#hero');
    const driftFieldEl = $('#drift-field');
    const typingEl = $('#typing');
    const announceEl = $('#announce');
    const announceText = $('#announce-text');
    const nowDreamerEl = $('#now-dreamer');
    const caretEl = $('#caret');
    const pauseBtn = $('#pause-btn');
    const machineEl = $('.machine-wrap .typewriter');
    const mount3D = $('#machine-3d');

    // 尝试初始化 3D 打字机（WebGL 不支持时优雅降级）
    let machine3D = null;
    if (mount3D) {
      try {
        machine3D = initMachine3D(mount3D, { aspect: 0.5 });
      } catch (err) {
        console.warn('3D machine init failed, falling back to SVG:', err);
      }
    }

    if (queue.length && typingEl && driftFieldEl) {
      const driftField = new DriftField(driftFieldEl, queue.slice(0, 12));
      const typer = new Typewriter({
        typingEl, announceEl, announceText, nowDreamerEl, caretEl,
        queue, driftField, machineEl, machine3D,
      });
      typer.start();

      setupParallax(hero, driftFieldEl);

      // 空格暂停 / 点击舞台外跳过当前
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.target.matches('input, textarea, button')) {
          e.preventDefault();
          typer.togglePause();
          if (pauseBtn) pauseBtn.textContent = typer.paused ? 'resume · space' : 'pause · space';
        } else if (e.code === 'ArrowRight') {
          typer.skip();
        }
      });
      if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
          typer.togglePause();
          pauseBtn.textContent = typer.paused ? 'resume · space' : 'pause · space';
        });
      }
    }
  }

  // 单条页：打字机只播这一条，打完淡入 footer
  const singleEl = $('#single-dream');
  if (singleEl) {
    let dream = null;
    try { dream = JSON.parse(singleEl.textContent || 'null'); } catch (_) {}

    const typingEl = $('#typing-single');
    const footer = $('#single-footer');
    const machineEl = $('.machine-wrap .typewriter');
    const machineKeys = machineEl ? Array.from(machineEl.querySelectorAll('.key')) : [];
    const mount3D = $('#machine-3d');

    let machine3D = null;
    if (mount3D) {
      try { machine3D = initMachine3D(mount3D, { aspect: 0.55 }); }
      catch (err) { console.warn('3D machine init failed:', err); }
    }

    const tick = (ch) => {
      if (machine3D && machine3D.mounted) { machine3D.tick(ch); return; }
      if (!machineEl) return;
      if (machineKeys.length) {
        const k = machineKeys[Math.floor(Math.random() * machineKeys.length)];
        k.classList.remove('pressed');
        void k.getBoundingClientRect();
        k.classList.add('pressed');
        setTimeout(() => k.classList.remove('pressed'), 230);
      }
      machineEl.classList.add('typing-active');
      clearTimeout(tick._t);
      tick._t = setTimeout(() => machineEl.classList.remove('typing-active'), 250);
    };
    const breakLine = () => {
      if (machine3D && machine3D.mounted) { machine3D.breakLine(); return; }
      if (!machineEl) return;
      machineEl.classList.add('line-break');
      setTimeout(() => machineEl.classList.remove('line-break'), 600);
    };

    if (dream && typingEl) {
      (async () => {
        await sleep(700);
        for (let i = 0; i < dream.entries.length; i++) {
          const text = dream.entries[i];
          const line = document.createElement('span');
          line.className = 'line';
          typingEl.appendChild(line);
          for (const ch of Array.from(text)) {
            line.textContent += ch;
            tick(ch);
            let delay = /[。，,.?！!?…—]/.test(ch) ? rand(280, 480) : rand(35, 95);
            await sleep(delay);
          }
          if (i < dream.entries.length - 1) {
            breakLine();
            await sleep(rand(700, 1100));
          }
        }
        await sleep(1200);
        if (footer) footer.classList.add('show');
      })();
    } else if (footer) {
      footer.classList.add('show');
    }
  }

  // ==========================================================
  // 7. Report（举报）——非常低调，点开弹一个 prompt
  // ==========================================================
  function setupReport() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.report-btn');
      if (!btn) return;
      e.preventDefault();

      const dreamId = btn.dataset.dreamId;
      if (!dreamId) return;

      // 防止重复 report
      if (btn.classList.contains('reported')) {
        btn.setAttribute('title', 'already reported · thanks');
        return;
      }

      const reason = window.prompt(
        'report this dream — what feels wrong about it?\n(optional, max 500 chars)',
        ''
      );
      // 用户按了取消：reason === null
      if (reason === null) return;

      try {
        const resp = await fetch('/api/dreams/' + encodeURIComponent(dreamId) + '/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: (reason || '').slice(0, 500) }),
        });
        const d = await resp.json();
        if (d.ok) {
          btn.classList.add('reported');
          btn.setAttribute('title', 'reported · thanks');
          btn.textContent = '✓';
        }
      } catch (_) {
        // 静默失败；用户不需要看到错误细节
      }
    });
  }

  setupResonance();
  setupArchive();
  setupReport();
})();

// Theme toggle — persists to localStorage; the anti-FOUC script in <head> set the initial value.
;(function () {
  var root = document.documentElement
  var btn = document.getElementById('theme-toggle')
  if (!btn) return
  function current() {
    return root.getAttribute('data-theme') || 'light' // light-first default
  }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark'
    root.setAttribute('data-theme', next)
    try {
      localStorage.setItem('babystack-theme', next)
    } catch (e) {}
  })
})()

// Terminals — type a scripted session and loop; static transcript under reduced-motion.
// Supports any number of terminals on a page (hero + the agent-loop demo).
;(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches
  var SPEED = 20
  var SAY = '#8AA4F8' // agent narration (periwinkle)
  var PROMPT = '#7FA6FF'
  var TEXT = '#e6e9ee'

  function el(tag, cls) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    return n
  }
  function span(color, text) {
    var s = el('span')
    s.style.color = color
    s.textContent = text
    return s
  }
  function caret(blink) {
    return el('span', blink ? 'caret' : 'caret static')
  }
  function wait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }

  function idleRow(term, blink) {
    var idle = el('div', 'row')
    idle.style.marginTop = '0.55em'
    idle.appendChild(span(PROMPT, '$ '))
    idle.appendChild(caret(blink))
    term.appendChild(idle)
  }

  function renderStatic(term, SCRIPT) {
    term.textContent = ''
    SCRIPT.forEach(function (s) {
      if (s.k === 'gap') return term.appendChild(el('div', 'gap'))
      var row = el('div', 'row')
      if (s.k === 'cmd') {
        row.appendChild(span(PROMPT, '$ '))
        row.appendChild(span(TEXT, s.t))
      } else if (s.k === 'say') {
        row.appendChild(span(SAY, s.t))
      } else {
        row.style.color = s.c || '#e6e9ee'
        row.textContent = s.t
      }
      term.appendChild(row)
    })
    idleRow(term, false)
  }

  function play(term, SCRIPT) {
    var alive = true
    ;(async function run() {
      while (alive) {
        term.textContent = ''
        for (var i = 0; i < SCRIPT.length; i++) {
          if (!alive) return
          var s = SCRIPT[i]
          if (s.k === 'gap') {
            term.appendChild(el('div', 'gap'))
            await wait(180)
            continue
          }
          if (s.k === 'out') {
            await wait(280)
            var o = el('div', 'row')
            o.style.color = s.c || '#e6e9ee'
            o.textContent = s.t
            term.appendChild(o)
            continue
          }
          // 'cmd' or 'say' — type char-by-char with a caret
          var row = el('div', 'row')
          if (s.k === 'cmd') row.appendChild(span(PROMPT, '$ '))
          var txt = span(s.k === 'say' ? SAY : TEXT, '')
          var car = caret(true)
          row.appendChild(txt)
          row.appendChild(car)
          term.appendChild(row)
          for (var j = 1; j <= s.t.length; j++) {
            if (!alive) return
            txt.textContent = s.t.slice(0, j)
            await wait(SPEED)
          }
          car.remove()
          await wait(s.k === 'say' ? 340 : 240)
        }
        idleRow(term, true)
        await wait(3200)
      }
    })()
  }

  function init(id, SCRIPT) {
    var term = document.getElementById(id)
    if (!term) return
    if (reduce) renderStatic(term, SCRIPT)
    else play(term, SCRIPT)
  }

  // Hero — the operator's shell: wake → home → break → reset.
  init('term', [
    { k: 'cmd', t: 'baby wake' },
    { k: 'out', t: 'baby: awake — real MySQL on 127.0.0.1:54903', c: '#6FE3AE' },
    { k: 'gap' },
    { k: 'cmd', t: 'eval "$(baby home)"' },
    { k: 'out', t: 'export DATABASE_URL=mysql://root@127.0.0.1:54903/app', c: '#7b828c' },
    { k: 'gap' },
    { k: 'cmd', t: 'mysql "$DATABASE_URL" -e "DELETE FROM orders"' },
    { k: 'out', t: 'Query OK, 42 rows affected  — you just nuked the data', c: '#F2B559' },
    { k: 'gap' },
    { k: 'cmd', t: 'baby reset' },
    { k: 'out', t: 'baby: reset — pristine baseline restored.', c: '#6FE3AE' },
  ])

  // Agent-loop demo (index §02) — a coding agent breaks a real DB, then undoes it.
  init('term-agent', [
    { k: 'say', t: '▸ testing a migration against the seeded DB…' },
    { k: 'cmd', t: 'mysql "$DATABASE_URL" < migrations/003_drop_legacy.sql' },
    { k: 'out', t: "✗ 1,204 rows gone — that migration isn't reversible", c: '#F2B559' },
    { k: 'gap' },
    { k: 'say', t: "▸ good thing it's disposable. undo:" },
    { k: 'cmd', t: 'baby reset' },
    { k: 'out', t: 'baby: reset — pristine baseline, same URL', c: '#6FE3AE' },
    { k: 'gap' },
    { k: 'say', t: "▸ clean slate. now I'll guard that migration." },
  ])
})()

// Interactive config builder (docs page) — generates a syntax-highlighted babystack.config.ts live.
;(function () {
  var root = document.getElementById('cfg-builder')
  if (!root) return

  var PRESETS = {
    drizzle: { build: ['pnpm db:migrate', 'pnpm db:seed'], globs: ['drizzle/**', 'db/seed.*'] },
    prisma: { build: ['pnpm prisma migrate deploy', 'pnpm db:seed'], globs: ['prisma/**'] },
    knex: {
      build: ['pnpm knex migrate:latest', 'pnpm knex seed:run'],
      globs: ['migrations/**', 'seeds/**'],
    },
    sql: { build: ['pnpm db:setup'], globs: ['db/**'] },
  }
  var NAME_RE = /^[A-Za-z0-9_]{1,32}$/
  var $ = function (id) {
    return document.getElementById(id)
  }
  var nameEl = $('cfg-name'),
    imageEl = $('cfg-image'),
    presetEl = $('cfg-preset'),
    cleanupEl = $('cfg-cleanup'),
    invEl = $('cfg-invalidate'),
    hintEl = $('cfg-name-hint'),
    outEl = $('cfg-out'),
    copyBtn = $('cfg-copy')

  var q = function (s) {
    return "'" + s + "'"
  }

  // Colour the generated TS the same way the static code blocks do — strings green, keywords blue.
  // Everything is built with textContent, so constrained input can never inject markup.
  function highlight(text) {
    outEl.textContent = ''
    var STR = /'[^']*'/g
    var last = 0,
      m
    var pushPlain = function (s) {
      var KW = /\b(import|from|export|default)\b/g
      var li = 0,
        k
      while ((k = KW.exec(s))) {
        if (k.index > li) outEl.appendChild(document.createTextNode(s.slice(li, k.index)))
        var kw = document.createElement('span')
        kw.style.color = '#7fa6ff'
        kw.textContent = k[0]
        outEl.appendChild(kw)
        li = k.index + k[0].length
      }
      if (li < s.length) outEl.appendChild(document.createTextNode(s.slice(li)))
    }
    while ((m = STR.exec(text))) {
      if (m.index > last) pushPlain(text.slice(last, m.index))
      var ss = document.createElement('span')
      ss.style.color = '#6fe3ae'
      ss.textContent = m[0]
      outEl.appendChild(ss)
      last = m.index + m[0].length
    }
    if (last < text.length) pushPlain(text.slice(last))
  }

  function build() {
    var raw = nameEl.value.trim()
    var ok = NAME_RE.test(raw)
    hintEl.textContent = ok || raw === '' ? '' : 'letters, digits, underscore (1–32)'
    var svc = ok ? raw : 'db'
    var preset = PRESETS[presetEl.value] || PRESETS.drizzle
    var cleanup = cleanupEl.value
    var addInv = invEl.value === 'yes'

    var L = []
    L.push("import { defineConfig } from '@babystack/core'")
    L.push('')
    L.push('export default defineConfig({')
    L.push('  services: {')
    L.push('    ' + svc + ': {')
    L.push("      engine: 'mysql',")
    L.push("      image: '" + imageEl.value + "',")
    L.push('      baseline: {')
    L.push('        build: [' + preset.build.map(q).join(', ') + '],')
    if (addInv) L.push('        invalidateWhenChanged: [' + preset.globs.map(q).join(', ') + '],')
    L.push('      },')
    if (cleanup !== 'destroy') L.push("      test: { cleanup: '" + cleanup + "' },")
    L.push('    },')
    L.push('  },')
    L.push('})')
    highlight(L.join('\n'))
  }

  ;[nameEl, imageEl, presetEl, cleanupEl, invEl].forEach(function (elm) {
    elm.addEventListener('input', build)
    elm.addEventListener('change', build)
  })

  copyBtn.addEventListener('click', function () {
    var text = outEl.textContent
    var done = function () {
      var prev = copyBtn.textContent
      copyBtn.textContent = 'copied ✓'
      setTimeout(function () {
        copyBtn.textContent = prev
      }, 1400)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done)
    } else {
      done()
    }
  })

  build()
})()

// Usage playground — how you actually use babystack: set it up once, then just run.
// Illustrative walkthrough (not a live run); the measured numbers live on the Why page.
;(function () {
  var pg = document.getElementById('playground')
  if (!pg) return
  var $ = function (id) {
    return document.getElementById(id)
  }
  var fwEl = $('pg-fw'),
    workersEl = $('pg-workers'),
    runBtn = $('pg-run'),
    railEl = $('pg-rail'),
    codeEl = $('pg-code'),
    setupItems = pg.querySelectorAll('.pg-setup li'),
    runViz = $('pg-run-viz'),
    dbsEl = $('pg-dbs'),
    captionEl = $('pg-caption'),
    scrubEl = $('pg-scrub'),
    backBtn = $('pg-back'),
    nextBtn = $('pg-next')

  var FW = {
    drizzle: "['pnpm db:migrate', 'pnpm db:seed']",
    prisma: "['pnpm prisma migrate deploy', 'pnpm db:seed']",
    knex: "['pnpm knex migrate:latest', 'pnpm knex seed:run']",
    sql: "['pnpm db:setup']",
  }

  var STAGES = [
    { label: 'Install', cap: 'Add the MySQL + Vitest wedge to your dev dependencies. Once.' },
    {
      label: 'Configure',
      cap: 'Describe your backend once — babystack runs your own migrate + seed to build the baseline.',
    },
    { label: 'Wire Vitest', cap: 'Three lines in vitest.config.ts. The entire test-infra change.' },
    {
      label: 'Write tests',
      cap: 'Your tests do not change — they read DATABASE_URL, exactly like production. No babystack import.',
    },
    {
      label: 'Run',
      cap: 'That is the whole usage — you type pnpm test, and babystack does the rest.',
    },
  ]
  var idx = 0

  function workers() {
    return parseInt(workersEl.value, 10)
  }

  function code() {
    var build = FW[fwEl.value] || FW.drizzle
    return [
      '<div class="fn">your terminal</div>' +
        '<span class="p">$</span> pnpm add -D <span class="s">@babystack/vitest @babystack/mysql @babystack/core</span>\n' +
        '<span class="muted">▹ + 3 dev dependencies</span>',

      '<div class="fn">babystack.config.ts</div>' +
        '<span class="k">import</span> { defineConfig } <span class="k">from</span> <span class="s">\'@babystack/core\'</span>\n\n' +
        '<span class="k">export default</span> defineConfig({\n' +
        '  services: {\n' +
        '    db: {\n' +
        '      engine: <span class="s">\'mysql\'</span>,\n' +
        '      baseline: { build: <span class="s">' +
        build +
        '</span> },\n' +
        '    },\n' +
        '  },\n' +
        '})',

      '<div class="fn">vitest.config.ts</div>' +
        'test: {\n' +
        '  globalSetup: [<span class="s">\'@babystack/vitest/global-setup\'</span>],\n' +
        '  setupFiles: [<span class="s">\'@babystack/vitest/setup\'</span>],\n' +
        '  pool: <span class="s">\'forks\'</span>,\n' +
        '}\n' +
        '<span class="muted">▹ the whole test-infra change — three lines</span>',

      '<div class="fn">tests/users.test.ts</div>' +
        '<span class="k">import</span> { test, expect } <span class="k">from</span> <span class="s">\'vitest\'</span>\n' +
        '<span class="k">import</span> request <span class="k">from</span> <span class="s">\'supertest\'</span>\n' +
        '<span class="k">import</span> { app } <span class="k">from</span> <span class="s">\'../src/app\'</span>  <span class="muted">// reads process.env.DATABASE_URL</span>\n\n' +
        'test(<span class="s">\'creates a user\'</span>, <span class="k">async</span> () => {\n' +
        '  <span class="k">const</span> res = <span class="k">await</span> request(app).post(<span class="s">\'/users\'</span>)\n' +
        '  expect(res.status).toBe(<span class="s">201</span>)\n' +
        '})\n' +
        '<span class="muted">// no babystack import — the DB is already fresh + seeded</span>',

      '<div class="fn">your terminal</div>' +
        '<span class="p">$</span> pnpm test\n' +
        '<span class="muted">▹ babystack: real MySQL ready · baseline cached</span>\n' +
        '<span class="ok">✓ tests/users.test.ts</span>\n' +
        '<span class="ok">✓ tests/orders.test.ts</span>\n' +
        '<span class="ok">✓ Test Files  passed — isolated, real MySQL</span>\n' +
        '<span class="muted">▹ teardown clean — zero containers left</span>',
    ]
  }

  function buildDbs() {
    dbsEl.innerHTML = ''
    var n = workers()
    for (var i = 1; i <= n; i++) {
      var d = document.createElement('div')
      d.className = 'pg-db'
      d.style.transitionDelay = (i - 1) * 70 + 'ms'
      d.textContent = 'db_w' + i + ' ✓'
      dbsEl.appendChild(d)
    }
  }

  function buildRail() {
    railEl.innerHTML = ''
    STAGES.forEach(function (s, i) {
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'pg-step'
      b.innerHTML = '<span class="n">' + (i + 1) + '</span> ' + s.label
      b.addEventListener('click', function () {
        idx = i
        render()
      })
      railEl.appendChild(b)
    })
  }

  function render() {
    var rail = railEl.children
    for (var i = 0; i < rail.length; i++) {
      rail[i].classList.toggle('done', i < idx)
      rail[i].classList.toggle('active', i === idx)
    }
    codeEl.innerHTML = code()[idx]
    for (var s = 0; s < setupItems.length; s++) {
      setupItems[s].classList.toggle('on', idx >= s)
    }
    var run = idx >= 4
    runViz.classList.toggle('show', run)
    var dbs = dbsEl.children
    for (var d = 0; d < dbs.length; d++) {
      dbs[d].classList.toggle('show', run)
      dbs[d].classList.toggle('green', run)
    }
    scrubEl.value = idx
    captionEl.textContent = STAGES[idx].cap
    runBtn.textContent = idx >= STAGES.length - 1 ? '↻ Start over' : 'Next step →'
  }

  // Manual, user-paced stepping — no auto-play, so people can read each step.
  runBtn.addEventListener('click', function () {
    idx = idx >= STAGES.length - 1 ? 0 : idx + 1
    render()
  })
  backBtn.addEventListener('click', function () {
    idx = Math.max(0, idx - 1)
    render()
  })
  nextBtn.addEventListener('click', function () {
    idx = Math.min(STAGES.length - 1, idx + 1)
    render()
  })
  scrubEl.addEventListener('input', function () {
    idx = parseInt(scrubEl.value, 10)
    render()
  })
  fwEl.addEventListener('change', render)
  workersEl.addEventListener('change', function () {
    buildDbs()
    render()
  })

  buildRail()
  buildDbs()
  render()
})()

// Docs sidebar — highlight the section currently in view.
;(function () {
  var side = document.querySelector('.docs-side')
  if (!side || !('IntersectionObserver' in window)) return
  var links = Array.prototype.slice.call(side.querySelectorAll('a[href^="#"]'))
  var byId = {}
  links.forEach(function (a) {
    byId[a.getAttribute('href').slice(1)] = a
  })
  var obs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          links.forEach(function (a) {
            a.classList.remove('on')
          })
          var a = byId[e.target.id]
          if (a) a.classList.add('on')
        }
      })
    },
    { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
  )
  document.querySelectorAll('.doc-sec[id]').forEach(function (s) {
    obs.observe(s)
  })
})()

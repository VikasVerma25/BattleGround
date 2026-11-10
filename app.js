(function () {
  'use strict';

  var MAX_NAME_LENGTH = 50;
  var REQUEST_TIMEOUT_MS = 30000;
  var MIN_LOADING_MS = 2000; // long enough to see at least one full clash (1.6s cycle)

  var app = document.getElementById('app');
  var screens = {
    input: document.getElementById('screen-input'),
    loading: document.getElementById('screen-loading'),
    result: document.getElementById('screen-result')
  };
  var form = document.getElementById('fight-form');
  var inputA = document.getElementById('fighter-a');
  var inputB = document.getElementById('fighter-b');
  var fightBtn = document.getElementById('fight-btn');
  var formError = document.getElementById('form-error');
  var dialog = document.getElementById('error-dialog');
  var dialogMessage = document.getElementById('error-message');
  var inFlight = false;
  var ignoreSubmitUntil = 0;

  // ---------- Screens ----------

  // Show exactly one screen. Hidden screens get the `hidden` attribute, which
  // removes them from the tab order and from screen readers.
  function showScreen(name) {
    if (!screens[name]) return;
    app.dataset.screen = name;
    Object.keys(screens).forEach(function (key) {
      screens[key].hidden = key !== name;
    });
    screens[name].focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ---------- Error pop-up ----------

  function showError(message) {
    dialogMessage.textContent = message;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      window.alert(message); // very old browsers without <dialog>
    }
  }

  function closeError() {
    if (dialog.open) dialog.close();
  }

  document.getElementById('error-close').addEventListener('click', closeError);
  document.getElementById('error-retry').addEventListener('click', function () {
    closeError();
    form.requestSubmit();
  });

  // ---------- Validation ----------

  function cleanName(value) {
    return value.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Returns { a, b } or throws an Error with a user-facing message.
  function validate() {
    var a = cleanName(inputA.value);
    var b = cleanName(inputB.value);
    if (!a || !b) throw new Error('An empty corner! Both fighters need to step into the ring.');
    if (a.length > MAX_NAME_LENGTH || b.length > MAX_NAME_LENGTH) {
      throw new Error('Too long for the ring announcer! Keep each name to ' + MAX_NAME_LENGTH + ' characters or fewer.');
    }
    if (a.toLowerCase() === b.toLowerCase()) throw new Error('No shadow boxing! Pick two different fighters.');
    return { a: a, b: b };
  }

  // ---------- API ----------

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Resolves with { winner, reasoning, fighterA, fighterB } or rejects with an
  // Error whose message is safe to show the user.
  async function requestVerdict(a, b) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var res;
    try {
      res = await fetch('/api/verdict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighterA: a, fighterB: b }),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('This fight dragged on so long the crowd went home. Give it another round!');
      }
      throw new Error(
        'The arena is unreachable! Check your connection, and if you are running locally, ' +
        'open the app through the dev server rather than as a file.'
      );
    } finally {
      clearTimeout(timer);
    }

    var data = null;
    try {
      data = await res.json();
    } catch (err) {
      /* not JSON */
    }

    if (!res.ok) {
      if (data && typeof data.error === 'string') throw new Error(data.error);
      throw new Error('The arena sent back something strange (HTTP ' + res.status + '). Try again!');
    }
    if (!data || typeof data.winner !== 'string' || typeof data.reasoning !== 'string') {
      throw new Error('The referee scribbled the verdict in invisible ink. Run the fight again!');
    }
    return data;
  }

  // ---------- Render ----------

  var TYPE_START_DELAY_MS = 1300; // wait for the winner reveal to finish
  var TYPE_SPEED_MS = 20;
  var reasoningTyped = document.getElementById('reasoning-typed');
  var reasoningFull = document.getElementById('reasoning-full');
  var skipBtn = document.getElementById('skip-btn');
  var typeTimer = null;
  var typeText = '';

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function stopTyping() {
    clearTimeout(typeTimer);
    typeTimer = null;
    skipBtn.hidden = true;
  }

  // Show all the reasoning immediately (skip button, reduced motion, leaving the screen).
  function finishTyping() {
    stopTyping();
    reasoningTyped.textContent = typeText;
  }

  function startTyping(text) {
    stopTyping();
    typeText = text;
    reasoningTyped.textContent = '';
    if (prefersReducedMotion()) {
      finishTyping();
      return;
    }
    skipBtn.hidden = false;
    var i = 0;
    function tick() {
      i += 1;
      reasoningTyped.textContent = typeText.slice(0, i);
      if (i >= typeText.length) {
        stopTyping();
      } else {
        typeTimer = setTimeout(tick, TYPE_SPEED_MS);
      }
    }
    typeTimer = setTimeout(tick, TYPE_START_DELAY_MS);
  }

  skipBtn.addEventListener('click', finishTyping);

  function renderResult(v) {
    // textContent only: names and reasoning are user/model supplied.
    document.getElementById('result-title').textContent = v.winner;

    var chipA = document.getElementById('result-a');
    var chipB = document.getElementById('result-b');
    chipA.textContent = v.fighterA;
    chipB.textContent = v.fighterB;
    var aWon = v.winner === v.fighterA;
    chipA.classList.toggle('is-winner', aWon);
    chipA.classList.toggle('is-loser', !aWon);
    chipB.classList.toggle('is-winner', !aWon);
    chipB.classList.toggle('is-loser', aWon);

    currentVerdict = v;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to BattleDex';

    reasoningFull.textContent = v.reasoning; // complete text for screen readers
    startTyping(v.reasoning);
  }

  // ---------- BattleDex storage ----------

  var STORE_KEY = 'battleground.battledex.v1';
  var memoryStore = null; // used when localStorage is unavailable
  var storageOk = true;

  function getStorage() {
    try {
      var s = window.localStorage;
      var probe = '__bg_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (err) {
      return null;
    }
  }

  function isValidEntry(e) {
    return e && typeof e.id === 'string' && typeof e.fighterA === 'string' &&
      typeof e.fighterB === 'string' && typeof e.winner === 'string' &&
      typeof e.reasoning === 'string' && typeof e.date === 'string';
  }

  var store = {
    // Returns an array of entries, newest first.
    load: function () {
      var raw = null;
      var s = getStorage();
      if (!s) {
        storageOk = false;
        return memoryStore ? memoryStore.slice() : [];
      }
      try {
        raw = s.getItem(STORE_KEY);
        var list = raw ? JSON.parse(raw) : [];
        storageOk = true;
        return Array.isArray(list) ? list.filter(isValidEntry) : [];
      } catch (err) {
        return []; // corrupt data: treat as empty
      }
    },
    _write: function (list) {
      var s = getStorage();
      if (!s) {
        storageOk = false;
        memoryStore = list;
        return { ok: false, reason: 'unavailable' };
      }
      try {
        s.setItem(STORE_KEY, JSON.stringify(list));
        return { ok: true };
      } catch (err) {
        var quota = err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
        return { ok: false, reason: quota ? 'quota' : 'error' };
      }
    },
    save: function (entry) {
      var list = store.load();
      list.unshift(entry);
      return store._write(list);
    },
    remove: function (id) {
      return store._write(store.load().filter(function (e) { return e.id !== id; }));
    },
    clear: function () {
      var s = getStorage();
      memoryStore = null;
      if (!s) return { ok: false, reason: 'unavailable' };
      try {
        s.removeItem(STORE_KEY);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'error' };
      }
    }
  };

  // ---------- BattleDex UI ----------

  var dexList = document.getElementById('battledex-list');
  var dexEmpty = document.getElementById('battledex-empty');
  var dexNotice = document.getElementById('battledex-notice');
  var clearBtn = document.getElementById('clear-btn');
  var clearConfirm = document.getElementById('clear-confirm');
  var saveBtn = document.getElementById('save-btn');
  var currentVerdict = null;

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function notice(message) {
    dexNotice.textContent = message || '';
    dexNotice.hidden = !message;
  }

  function failMessage(res) {
    if (res.reason === 'quota') return 'The BattleDex is stuffed to the rafters! Delete a few old fights to make room.';
    if (res.reason === 'unavailable') return 'Your browser is locking the BattleDex vault, so fights only last until you close or reload this page.';
    return 'This fight slipped out of the BattleDex. Try saving it again!';
  }

  function renderDex() {
    var entries = store.load();
    dexList.textContent = '';
    dexEmpty.hidden = entries.length > 0;
    clearBtn.hidden = entries.length === 0;
    if (entries.length === 0) clearConfirm.hidden = true;
    if (!storageOk) notice(failMessage({ reason: 'unavailable' }));

    entries.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 'dex-entry';

      var body = document.createElement('div');
      body.className = 'dex-body';
      var w = document.createElement('p');
      w.className = 'dex-winner';
      w.textContent = e.winner + ' wins';
      var m = document.createElement('p');
      m.className = 'dex-matchup';
      m.textContent = e.fighterA + ' vs ' + e.fighterB;
      var r = document.createElement('p');
      r.className = 'dex-reasoning';
      r.textContent = e.reasoning;
      var d = document.createElement('p');
      d.className = 'dex-date';
      var when = new Date(e.date);
      d.textContent = isNaN(when) ? '' : when.toLocaleString();
      body.append(w, m, r, d);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-small';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', 'Delete fight: ' + e.fighterA + ' vs ' + e.fighterB);
      del.addEventListener('click', function () {
        var res = store.remove(e.id);
        notice(res.ok ? '' : failMessage(res));
        renderDex();
      });

      li.append(body, del);
      dexList.appendChild(li);
    });
  }

  saveBtn.addEventListener('click', function () {
    if (!currentVerdict) return;
    var res = store.save({
      id: newId(),
      fighterA: currentVerdict.fighterA,
      fighterB: currentVerdict.fighterB,
      winner: currentVerdict.winner,
      reasoning: currentVerdict.reasoning,
      date: new Date().toISOString()
    });
    if (res.ok) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved ✓';
      notice('');
    } else {
      // Quota/blocked: keep the button enabled so the user can retry, and say why.
      saveBtn.textContent = res.reason === 'quota' ? 'Dex full! Retry' : 'Fumbled! Retry';
      saveBtn.title = failMessage(res);
      notice(failMessage(res));
    }
    renderDex();
  });

  clearBtn.addEventListener('click', function () {
    clearBtn.hidden = true;
    clearConfirm.hidden = false;
    document.getElementById('clear-no').focus();
  });
  document.getElementById('clear-no').addEventListener('click', function () {
    clearConfirm.hidden = true;
    clearBtn.hidden = false;
    clearBtn.focus();
  });
  document.getElementById('clear-yes').addEventListener('click', function () {
    var res = store.clear();
    clearConfirm.hidden = true;
    notice(res.ok ? '' : failMessage(res));
    renderDex();
  });

  // ---------- Crowd posters (loading screen) ----------

  // {A} and {B} are replaced with the (shortened) fighter names.
  var POSTERS = [
    'GO {A}!', '{B} FOR THE WIN', 'TEAM {A}', 'TEAM {B}', '{A} FOREVER', '{B} OR BUST',
    'I BET MY LUNCH ON {A}', 'I BET MY LUNCH ON {B}', '{A} IS MY HERO', '{B} IS MY HERO',
    'FINISH HIM!', 'ROUND? NO, ONE SHOT', 'MY MOM IS HERE', 'HI MOM!', 'SNACKS AFTER THIS',
    'DO A BARREL ROLL', 'NO REFUNDS', 'WINNER GETS PIZZA', 'LOSER DOES DISHES',
    'FIGHT! FIGHT! FIGHT!', 'PUNCH IT!', 'BONK!', 'KAPOW!', 'WHO WOULD WIN?',
    'I CAME FOR THE CHAOS', 'THIS WILL HURT', 'WORTH THE TICKET', 'MORE POPCORN PLEASE',
    'ASK ME ABOUT {A}', 'ASK ME ABOUT {B}', 'JUDGE, BE FAIR!', 'THE JUDGE IS WATCHING',
    'NO CAPES', 'WE WANT A REMATCH', 'THIS IS FINE', 'CLEAN FIGHT, PLEASE',
    'SOMEONE CALL A VET', 'SOMEONE CALL A LAWYER', 'LOUD NOISES!', 'ARENA OF DOOM',
    'BATTLEGROUND OR BUST', 'I SAW IT COMING', 'IT WAS ALL A DREAM', 'WIN IT FOR GRANDMA',
    'BRING IT ON', 'TO THE MOON!', 'SEND IT!', 'OUCH IN ADVANCE', 'PLOT TWIST INCOMING',
    'POWERED BY SNACKS', 'EYES UP, FOLKS', 'ABSOLUTE UNIT', 'UNDERDOG ENERGY',
    'BIG IF TRUE', 'I HAVE FRONT ROW SEATS', 'SIGN HELD UPSIDE DOWN', 'READ THIS SIGN',
    'BEST FIGHT EVER (SO FAR)', 'WHERE IS MY NACHO?', 'LET THEM COOK'
  ];
  // Horizontal slots (% from left): 5 on desktop, 3 on phones. 2-3 signs per fight.
  var SLOTS_DESKTOP = [2, 21, 40, 60, 79];
  var SLOTS_MOBILE = { 2: [1, 68], 3: [1, 34.5, 68] };
  var postersEl = document.getElementById('posters');

  function shortName(name) {
    var n = name.toUpperCase();
    return n.length > 14 ? n.slice(0, 13) + '…' : n;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Pick fresh random signs for this fight. Text goes in via textContent.
  function renderPosters(nameA, nameB) {
    postersEl.textContent = '';
    var count = 2 + Math.floor(Math.random() * 2); // 2 or 3
    var picks = shuffle(POSTERS).slice(0, count);
    var spots = shuffle(SLOTS_DESKTOP).slice(0, count).sort(function (x, y) { return x - y; });
    picks.forEach(function (text, i) {
      var el = document.createElement('div');
      el.className = 'poster poster-c' + (1 + Math.floor(Math.random() * 4));
      el.style.setProperty('--x', spots[i] + '%');
      el.style.setProperty('--xm', SLOTS_MOBILE[count][i] + '%');
      el.style.setProperty('--tilt', (Math.random() * 12 - 6).toFixed(1) + 'deg');
      el.style.setProperty('--lift', Math.round(Math.random() * 22) + 'px');
      el.style.setProperty('--delay', '-' + (Math.random() * 1.2).toFixed(2) + 's');
      var board = document.createElement('span');
      board.textContent = text.replace('{A}', shortName(nameA)).replace('{B}', shortName(nameB));
      el.appendChild(board);
      postersEl.appendChild(el);
    });
  }

  // ---------- Fight flow ----------

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (inFlight) return;
    // Swallow a double-click/double-tap or a held Enter that carries over from "Fight again".
    if (Date.now() < ignoreSubmitUntil) return;

    formError.hidden = true;
    formError.textContent = '';

    var names;
    try {
      names = validate();
    } catch (err) {
      showError(err.message);
      return;
    }

    inFlight = true;
    fightBtn.disabled = true;
    document.getElementById('loading-a').textContent = names.a;
    document.getElementById('loading-b').textContent = names.b;
    renderPosters(names.a, names.b);
    document.getElementById('hud-a').textContent = names.a;
    document.getElementById('hud-b').textContent = names.b;
    showScreen('loading');

    try {
      var results = await Promise.all([
        requestVerdict(names.a, names.b),
        sleep(MIN_LOADING_MS)
      ]);
      renderResult(results[0]);
      showScreen('result');
    } catch (err) {
      showScreen('input');
      showError(err.message || 'Chaos in the arena! Something unexpected happened. Try again.');
    } finally {
      inFlight = false;
      fightBtn.disabled = false;
    }
  });

  document.getElementById('again-btn').addEventListener('click', function () {
    stopTyping();
    ignoreSubmitUntil = Date.now() + 600;
    showScreen('input');
    inputA.focus();
  });

  // Start with only the input screen visible, without stealing focus.
  renderDex();
  showScreen('input');
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
})();

/* ==================================================================
   Wesele — aplikacja gosci.
   Przeplyw: backend (Apps Script) wydaje krotki token -> przegladarka
   wysyla plik BEZPOSREDNIO na Dysk Google (upload wznawialny) i czyta
   liste plikow. Apps Script nie przepuszcza przez siebie bajtow, wiec
   nie ma limitu 6 minut ani 50 MB.
   Sciezka zapasowa (proxy przez Apps Script) wlacza sie sama, jesli
   przegladarka zablokuje bezposredni upload.
   ================================================================== */
(function () {
  'use strict';

  var CFG = window.WESELE_CONFIG || {};
  var API = String(CFG.apiUrl || '').trim();
  var CHUNK = 8 * 1024 * 1024;        // 8 MB — wielokrotnosc 256 KB (wymog Google)
  var PROXY_CHUNK = 4 * 1024 * 1024;  // mniejsze kawalki dla sciezki zapasowej
  var THUMB = 'https://drive.google.com/thumbnail?id=';

  var $ = function (sel) { return document.querySelector(sel); };

  /* ---------------------------------------------------------------
     1. Pamiec urzadzenia — odporna na tryb prywatny i blokady storage
     --------------------------------------------------------------- */

  var store = (function () {
    var mem = {};
    function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

    function cookieGet(k) {
      var m = document.cookie.match('(^|; )' + k.replace(/\./g, '\\.') + '=([^;]*)');
      return m ? decodeURIComponent(m[2]) : null;
    }
    function cookieSet(k, v) {
      safe(function () {
        document.cookie = k + '=' + encodeURIComponent(v) +
          ';path=/;max-age=34560000;SameSite=Lax' +
          (location.protocol === 'https:' ? ';Secure' : '');
      });
    }

    return {
      get: function (k) {
        var key = 'wesele.' + k;
        var v = safe(function () { return localStorage.getItem(key); }, null);
        if (v === null || v === undefined) v = cookieGet(key);
        if (v === null || v === undefined) v = (key in mem) ? mem[key] : null;
        return v;
      },
      set: function (k, v) {
        var key = 'wesele.' + k;
        mem[key] = v;
        safe(function () { localStorage.setItem(key, v); });
        cookieSet(key, v);
      },
      getJSON: function (k, dflt) {
        var v = this.get(k);
        if (!v) return dflt;
        try { return JSON.parse(v); } catch (e) { return dflt; }
      },
      setJSON: function (k, v) { this.set(k, JSON.stringify(v)); }
    };
  })();

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      if (window.crypto && crypto.getRandomValues) {
        var a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      }
    } catch (e) { /* ignorujemy */ }
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var state = {
    deviceId: null,
    guest: null,
    folderId: null,
    items: [],          // pliki w galerii
    ids: {},            // id -> true
    nextPageToken: null,
    filter: 'all',
    loading: false,
    localThumbs: {},    // id -> objectURL (wlasne, swiezo wgrane zdjecia)
    lbIndex: -1,
    uploadMode: store.get('uploadMode') || 'direct'
  };

  state.deviceId = store.get('deviceId');
  if (!state.deviceId) { state.deviceId = uuid(); store.set('deviceId', state.deviceId); }
  state.guest = store.get('guest');

  /* ---------------------------------------------------------------
     2. Komunikacja z backendem (Apps Script)
     --------------------------------------------------------------- */

  function apiGet(params) {
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var url = API + (API.indexOf('?') >= 0 ? '&' : '?') + qs;

    return fetch(url, { method: 'GET', redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function () { return jsonp(params); });   // zapasowy kanal, gdyby CORS zawiodl
  }

  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = 'wcb' + Date.now() + Math.floor(Math.random() * 1000);
      var timer = setTimeout(function () { cleanup(); reject(new Error('Backend nie odpowiada')); }, 20000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      var qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      var s = document.createElement('script');
      s.src = API + (API.indexOf('?') >= 0 ? '&' : '?') + qs + '&callback=' + cb;
      s.onerror = function () { cleanup(); reject(new Error('Backend nie odpowiada')); };
      document.head.appendChild(s);
    });
  }

  /* Content-Type: text/plain -> proste zadanie, bez preflightu OPTIONS,
     ktorego Apps Script nie obsluguje. */
  function apiPost(body) {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  /* Log zdarzen — przez <img>, zeby zadne ustawienie CORS nie mialo znaczenia. */
  function log(type, msg) {
    if (!API) return;
    try {
      var img = new Image();
      img.src = API + '?action=log' +
        '&t=' + encodeURIComponent(type) +
        '&m=' + encodeURIComponent(String(msg || '').slice(0, 280)) +
        '&g=' + encodeURIComponent(state.guest || '') +
        '&d=' + encodeURIComponent((state.deviceId || '').slice(0, 8)) +
        '&ua=' + encodeURIComponent(navigator.userAgent.slice(0, 110)) +
        '&_=' + Date.now();
    } catch (e) { /* logowanie nigdy nie moze wywrocic aplikacji */ }
  }

  /* --------------------------- Token OAuth ------------------------ */

  var cfgCache = null, cfgAt = 0, cfgPromise = null;

  function getConfig(force) {
    var fresh = cfgCache && (Date.now() - cfgAt) < 9 * 60 * 1000;
    if (!force && fresh) return Promise.resolve(cfgCache);
    if (cfgPromise) return cfgPromise;
    var params = { action: 'config', _: Date.now() };
    if (force) params.fresh = '1';     // omin cache tokenu po stronie backendu
    cfgPromise = apiGet(params)
      .then(function (r) {
        cfgPromise = null;
        if (!r || !r.ok) throw new Error((r && r.error) || 'Backend nie odpowiada');
        cfgCache = r; cfgAt = Date.now();
        state.folderId = r.folderId;
        var ver = $('#ver');
        if (ver) ver.textContent = 'wersja ' + r.version;
        return r;
      })
      .catch(function (err) { cfgPromise = null; throw err; });
    return cfgPromise;
  }

  /** Zapytanie do Drive API z automatycznym odswiezeniem tokenu przy 401. */
  function drive(url, opts, isRetry) {
    opts = opts || {};
    return getConfig(false).then(function (cfg) {
      var headers = {};
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
      headers.Authorization = 'Bearer ' + cfg.token;
      return fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body
      });
    }).then(function (r) {
      if ((r.status === 401 || r.status === 403) && !isRetry) {
        return getConfig(true).then(function () { return drive(url, opts, true); });
      }
      return r;
    });
  }

  /* ---------------------------------------------------------------
     3. Galeria
     --------------------------------------------------------------- */

  var FIELDS = 'nextPageToken,files(id,name,mimeType,createdTime,size,appProperties)';

  function listFiles(pageToken) {
    var q = "'" + state.folderId + "' in parents and trashed=false";
    var params = 'q=' + encodeURIComponent(q) +
      '&orderBy=' + encodeURIComponent('createdTime desc') +
      '&pageSize=' + (CFG.pageSize || 60) +
      '&fields=' + encodeURIComponent(FIELDS) +
      '&spaces=drive' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    return drive('https://www.googleapis.com/drive/v3/files?' + params)
      .then(function (r) {
        if (!r.ok) throw new Error('Drive ' + r.status);
        return r.json();
      });
  }

  function isMine(f) {
    return !!(f.appProperties && f.appProperties.deviceId === state.deviceId);
  }
  function isVideo(f) {
    return String(f.mimeType || '').indexOf('video') === 0;
  }

  function visibleItems() {
    return state.filter === 'mine' ? state.items.filter(isMine) : state.items;
  }

  function loadFirstPage() {
    return getConfig(false)
      .then(function () { return listFiles(null); })
      .then(function (data) {
        state.items = [];
        state.ids = {};
        (data.files || []).forEach(addItem);
        state.nextPageToken = data.nextPageToken || null;
        render();
      });
  }

  function loadMore() {
    if (state.loading || !state.nextPageToken) return Promise.resolve();
    state.loading = true;
    return listFiles(state.nextPageToken)
      .then(function (data) {
        (data.files || []).forEach(addItem);
        state.nextPageToken = data.nextPageToken || null;
        render();
      })
      .catch(function (e) { log('error', 'loadMore: ' + e.message); })
      .then(function () { state.loading = false; });
  }

  /** Dociaga tylko nowosci z gory listy — tanie odswiezanie co kilkanascie sekund. */
  function refreshTop() {
    if (!state.folderId) return Promise.resolve();
    return listFiles(null)
      .then(function (data) {
        var added = 0;
        (data.files || []).slice().reverse().forEach(function (f) {
          if (!state.ids[f.id]) { addItem(f, true); added++; }
        });
        if (added) render();
      })
      .catch(function (e) { log('error', 'refresh: ' + e.message); });
  }

  function addItem(f, toFront) {
    if (state.ids[f.id]) return;
    state.ids[f.id] = true;
    if (toFront) state.items.unshift(f); else state.items.push(f);
  }

  function thumbUrl(f, size) {
    if (state.localThumbs[f.id]) return state.localThumbs[f.id];
    return THUMB + f.id + '&sz=w' + (size || 400);
  }

  function render() {
    var list = visibleItems();
    var grid = $('#gallery');
    var frag = document.createDocumentFragment();

    list.forEach(function (f, i) {
      var tile = document.createElement('button');
      tile.className = 'tile' + (isMine(f) ? ' is-mine' : '');
      tile.type = 'button';
      tile.setAttribute('aria-label', 'Powiększ zdjęcie od ' + guestOf(f));
      tile.dataset.index = i;

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = thumbUrl(f, 400);
      img.dataset.tries = '0';
      img.dataset.fid = f.id;
      img.onerror = retryThumb;
      tile.appendChild(img);

      if (isVideo(f)) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>';
        tile.appendChild(badge);
      }

      var tag = document.createElement('span');
      tag.className = 'who-tag';
      tag.textContent = guestOf(f);
      tile.appendChild(tag);

      tile.addEventListener('click', function () { openLightbox(i); });
      frag.appendChild(tile);
    });

    grid.innerHTML = '';
    grid.appendChild(frag);

    var guests = {};
    state.items.forEach(function (f) { guests[guestOf(f)] = 1; });
    var n = state.items.length, g = Object.keys(guests).length;
    $('#count').textContent = n
      ? n + ' ' + plural(n, 'zdjęcie', 'zdjęcia', 'zdjęć') +
        ' od ' + g + ' ' + plural(g, 'gościa', 'gości', 'gości')
      : '';
    $('#empty').hidden = list.length > 0;
    if (state.filter === 'mine' && !list.length && state.items.length) {
      $('#empty').querySelector('h2').textContent = 'Nie masz tu jeszcze zdjęć';
    } else {
      $('#empty').querySelector('h2').textContent = 'Jeszcze nic tu nie ma';
    }
  }

  /** Dysk generuje miniaturke kilka sekund po wgraniu — warto sprobowac ponownie. */
  function retryThumb(ev) {
    var img = ev.target;
    var tries = Number(img.dataset.tries || 0);
    if (tries >= 4) { img.style.visibility = 'hidden'; return; }
    img.dataset.tries = String(tries + 1);
    var id = img.dataset.fid;
    setTimeout(function () {
      if (img.src.indexOf('blob:') === 0 && id) {
        img.src = THUMB + id + '&sz=w800';       // podglad lokalny padl — bierzemy wersje z Dysku
      } else {
        img.src = img.src.split('&_r=')[0] + '&_r=' + Date.now();
      }
    }, 1500 * (tries + 1));
  }

  function guestOf(f) {
    return (f.appProperties && f.appProperties.guest) || 'Gosc';
  }

  /* ---------------------------------------------------------------
     4. Wysylanie plikow
     --------------------------------------------------------------- */

  var queue = [];
  var active = 0;
  var batchNotified = false;   // zeby podsumowanie pokazalo sie raz na partie

  function buildName(file) {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    var stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      '_' + p(d.getHours()) + '-' + p(d.getMinutes());
    var g = String(state.guest || 'Gosc').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-').slice(0, 32);
    var base = String(file.name || 'plik').replace(/[\\/:*?"<>|]/g, '').slice(-64);
    return stamp + '_' + g + '_' + base;
  }

  function dedupeKey(file) {
    return [file.name, file.size, file.lastModified || 0].join('|');
  }

  function enqueue(files) {
    var maxBytes = (CFG.maxFileMB || 2048) * 1024 * 1024;
    var seen = store.getJSON('sent', []);
    var added = 0, skipped = 0;

    Array.prototype.forEach.call(files, function (file) {
      if (!file || !file.size) return;
      if (file.size > maxBytes) {
        toast('Plik ' + file.name + ' jest za duży (limit ' + (CFG.maxFileMB || 2048) + ' MB).', true);
        return;
      }
      var key = dedupeKey(file);
      if (seen.indexOf(key) >= 0) { skipped++; return; }
      queue.push({
        id: uuid(),
        file: file,
        key: key,
        name: buildName(file),
        status: 'wait',
        loaded: 0,
        offset: 0,
        error: null
      });
      added++;
    });

    if (skipped) toast(skipped === 1 ? 'To zdjęcie już wysłałeś.' : 'Pominięto ' + skipped + ' już wysłanych ' + plural(skipped, 'zdjęcia', 'zdjęcia', 'zdjęć') + '.');
    if (!added) return;

    batchNotified = false;
    $('#uploads').hidden = false;
    renderQueue();
    pump();
  }

  function pump() {
    var parallel = CFG.parallelUploads || 2;
    while (active < parallel) {
      var next = null;
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].status === 'wait') { next = queue[i]; break; }
      }
      if (!next) break;
      runItem(next);
    }
    if (!active && queue.every(function (q) { return q.status === 'done' || q.status === 'err'; })) {
      finishBatch();
    }
  }

  function runItem(item) {
    active++;
    item.status = 'up';
    renderQueue();

    getConfig(false)
      .then(function () {
        var meta = {
          name: item.name,
          parents: [state.folderId],
          mimeType: item.file.type || 'application/octet-stream',
          appProperties: {
            deviceId: state.deviceId,
            guest: String(state.guest || 'Gosc').slice(0, 60)
          }
        };
        if (state.uploadMode === 'proxy') return uploadProxy(item, meta);
        return uploadDirect(item, meta).catch(function (err) {
          if (err && (err.code === 'no-location' || err.code === 'init-failed')) {
            // Przegladarka blokuje bezposredni upload — przechodzimy na proxy i zostajemy przy nim.
            state.uploadMode = 'proxy';
            store.set('uploadMode', 'proxy');
            log('mode_switch', 'proxy: ' + (err.message || err.code));
            item.loaded = 0;
            renderQueue();
            return uploadProxy(item, meta);
          }
          throw err;
        });
      })
      .then(function (created) {
        item.status = 'done';
        item.loaded = item.file.size;
        rememberSent(item.key);
        if (created && created.id) {
          if (String(item.file.type || '').indexOf('image') === 0) {
            try { state.localThumbs[created.id] = URL.createObjectURL(item.file); } catch (e) { /* ignorujemy */ }
          }
          if (!created.appProperties) {
            created.appProperties = { deviceId: state.deviceId, guest: state.guest };
          }
          addItem(created, true);
          render();
        }
        log('upload_ok', item.name + ' (' + mb(item.file.size) + ' MB)');
      })
      .catch(function (err) {
        item.status = 'err';
        item.error = friendlyError(err);
        log('upload_err', item.name + ': ' + (err && err.message || err));
      })
      .then(function () {
        active--;
        renderQueue();
        pump();
      });
  }

  function rememberSent(key) {
    var seen = store.getJSON('sent', []);
    seen.unshift(key);
    store.setJSON('sent', seen.slice(0, 400));
  }

  /* -------------------- Sciezka A: prosto na Dysk ------------------ */

  function uploadDirect(item, meta, isRetry) {
    return getConfig(false).then(function (cfg) {
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,createdTime,appProperties', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': item.file.type || 'application/octet-stream',
          'X-Upload-Content-Length': String(item.file.size)
        },
        body: JSON.stringify(meta)
      }).catch(function (e) {
        throw tagged('init-failed', 'Nie udało się rozpocząć wysyłki: ' + e.message);
      });
    }).then(function (r) {
      if ((r.status === 401 || r.status === 403) && !isRetry) {
        return getConfig(true).then(function () { return uploadDirect(item, meta, true); });
      }
      if (!r.ok) throw tagged('init-failed', 'Start wysyłki HTTP ' + r.status);
      var loc = r.headers.get('location') || r.headers.get('Location');
      if (!loc) throw tagged('no-location', 'Przeglądarka nie udostępnia adresu sesji');
      return pushChunks(item, loc);
    });
  }

  function pushChunks(item, sessionUrl) {
    var total = item.file.size;

    function step() {
      if (item.offset >= total) throw new Error('Wysyłka zakończona bez potwierdzenia');
      var end = Math.min(item.offset + CHUNK, total);
      var blob = item.file.slice(item.offset, end);
      var start = item.offset;

      return withRetry(function () {
        return putChunk(sessionUrl, blob, start, end - 1, total, function (loaded) {
          item.loaded = loaded;
          renderQueueProgress();
        });
      }, 4).then(function (res) {
        if (res.status === 308) {
          item.offset = end;
          item.loaded = end;
          renderQueueProgress();
          return step();
        }
        if (res.status === 200 || res.status === 201) {
          item.offset = total;
          try { return JSON.parse(res.body); } catch (e) { return {}; }
        }
        if (res.status === 404 || res.status === 410) {
          throw tagged('session-gone', 'Sesja wysyłki wygasła');
        }
        throw new Error('Dysk odpowiedział HTTP ' + res.status);
      });
    }

    return step();
  }

  function putChunk(sessionUrl, blob, start, end, total, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', sessionUrl, true);
      xhr.setRequestHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
      xhr.timeout = 10 * 60 * 1000;
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(start + e.loaded);
        };
      }
      xhr.onload = function () { resolve({ status: xhr.status, body: xhr.responseText }); };
      xhr.onerror = function () { reject(new Error('Przerwane połączenie')); };
      xhr.ontimeout = function () { reject(new Error('Przekroczono czas wysyłki')); };
      xhr.send(blob);
    });
  }

  /* ------------- Sciezka B: proxy przez Apps Script ---------------- */

  function uploadProxy(item, meta) {
    return apiPost({
      action: 'proxyInit',
      name: meta.name,
      mimeType: meta.mimeType,
      size: item.file.size,
      appProperties: meta.appProperties
    }).then(function (init) {
      if (!init || !init.ok) throw new Error((init && init.error) || 'Backend odmówił startu');
      var total = item.file.size;
      item.offset = 0;

      function step() {
        var end = Math.min(item.offset + PROXY_CHUNK, total);
        var start = item.offset;
        return blobToBase64(item.file.slice(start, end))
          .then(function (b64) {
            return withRetry(function () {
              return apiPost({
                action: 'proxyChunk',
                sessionId: init.sessionId,
                offset: start,
                total: total,
                data: b64
              });
            }, 3);
          })
          .then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || 'Błąd wysyłki');
            item.offset = end;
            item.loaded = end;
            renderQueueProgress();
            if (res.done) return res.file || {};
            if (item.offset >= total) throw new Error('Wysyłka zakończona bez potwierdzenia');
            return step();
          });
      }
      return step();
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(new Error('Nie udało się odczytać pliku')); };
      fr.readAsDataURL(blob);
    });
  }

  /* --------------------------- Pomocnicze ------------------------- */

  function withRetry(fn, attempts) {
    var tries = 0;
    function attempt() {
      return fn().catch(function (err) {
        tries++;
        if (tries >= attempts || (err && err.code === 'session-gone')) throw err;
        return wait(Math.pow(2, tries) * 700).then(attempt);
      });
    }
    return attempt();
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function tagged(code, msg) {
    var e = new Error(msg);
    e.code = code;
    return e;
  }

  function mb(bytes) { return (bytes / 1048576).toFixed(1); }

  /** Polska odmiana: 1 zdjecie, 2-4 zdjecia, 5+ zdjec. */
  function plural(n, one, few, many) {
    if (n === 1) return one;
    var d = n % 10, h = n % 100;
    if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
    return many;
  }

  function friendlyError(err) {
    var m = String((err && err.message) || err || '');
    if (/NotReadable|nie udalo sie odczytac/i.test(m)) {
      return 'Telefon nie mógł odczytać pliku — otwórz zdjęcie w galerii i spróbuj ponownie.';
    }
    if (/Przerwane|Failed to fetch|NetworkError|polaczenie/i.test(m)) {
      return 'Zerwane połączenie. Dotknij „Ponów błędne”.';
    }
    if (/czas/i.test(m)) return 'Za wolne połączenie. Spróbuj ponownie przy lepszym zasięgu.';
    return m.slice(0, 140);
  }

  /* ------------------------ Panel wysylania ----------------------- */

  function renderQueue() {
    var ul = $('#up-list');
    ul.innerHTML = '';
    queue.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'up-item';
      li.dataset.id = item.id;

      var thumb = document.createElement('div');
      thumb.className = 'up-thumb';
      if (String(item.file.type || '').indexOf('image') === 0) {
        var img = document.createElement('img');
        img.className = 'up-thumb';
        try { img.src = URL.createObjectURL(item.file); } catch (e) { /* ignorujemy */ }
        thumb = img;
      }
      li.appendChild(thumb);

      var main = document.createElement('div');
      main.className = 'up-main';
      var name = document.createElement('div');
      name.className = 'up-name';
      name.textContent = item.file.name;
      var sub = document.createElement('div');
      sub.className = 'up-sub' + (item.status === 'err' ? ' is-err' : item.status === 'done' ? ' is-ok' : '');
      sub.textContent =
        item.status === 'done' ? 'Gotowe' :
        item.status === 'err' ? item.error :
        item.status === 'up' ? 'Wysyłanie…' : 'W kolejce';
      var mini = document.createElement('div');
      mini.className = 'up-mini';
      var fill = document.createElement('span');
      fill.style.width = pct(item) + '%';
      mini.appendChild(fill);

      main.appendChild(name);
      main.appendChild(sub);
      main.appendChild(mini);
      li.appendChild(main);
      ul.appendChild(li);
    });
    renderQueueProgress();
  }

  function pct(item) {
    if (item.status === 'done') return 100;
    if (!item.file.size) return 0;
    return Math.min(100, Math.round(item.loaded / item.file.size * 100));
  }

  function renderQueueProgress() {
    var totalBytes = 0, doneBytes = 0, done = 0, errs = 0;
    queue.forEach(function (i) {
      totalBytes += i.file.size;
      doneBytes += (i.status === 'done' ? i.file.size : i.loaded);
      if (i.status === 'done') done++;
      if (i.status === 'err') errs++;
    });
    var percent = totalBytes ? Math.round(doneBytes / totalBytes * 100) : 0;
    $('#up-bar').style.width = percent + '%';
    $('#up-title').textContent = (done === queue.length)
      ? (errs ? 'Wysłano ' + (done - errs) + ' z ' + queue.length : 'Wysłano ' + done + ' z ' + queue.length)
      : 'Wysyłanie ' + Math.min(done + 1, queue.length) + ' z ' + queue.length + ' · ' + percent + '%';
    $('#up-retry').hidden = !errs;

    queue.forEach(function (item) {
      var li = $('#up-list li[data-id="' + item.id + '"]');
      if (!li) return;
      var fill = li.querySelector('.up-mini span');
      if (fill) fill.style.width = pct(item) + '%';
      var sub = li.querySelector('.up-sub');
      if (sub) {
        sub.className = 'up-sub' + (item.status === 'err' ? ' is-err' : item.status === 'done' ? ' is-ok' : '');
        sub.textContent =
          item.status === 'done' ? 'Gotowe' :
          item.status === 'err' ? item.error :
          item.status === 'up' ? pct(item) + '% · ' + mb(item.file.size) + ' MB' : 'W kolejce';
      }
    });
  }

  function finishBatch() {
    if (batchNotified || !queue.length) return;
    batchNotified = true;
    var done = queue.filter(function (i) { return i.status === 'done'; }).length;
    var errs = queue.filter(function (i) { return i.status === 'err'; }).length;
    if (done && !errs) {
      toast(done === 1 ? 'Zdjęcie dodane. Dziękujemy!' : 'Dodano ' + done + ' ' + plural(done, 'plik', 'pliki', 'plików') + '. Dziękujemy!');
      setTimeout(function () {
        if (!queue.some(function (i) { return i.status === 'up' || i.status === 'wait'; })) {
          $('#uploads').hidden = true;
          queue = [];
        }
      }, 2500);
    } else if (errs) {
      toast(errs + ' ' + plural(errs, 'plik się nie wysłał.', 'pliki się nie wysłały.', 'plików się nie wysłało.'), true);
    }
    refreshTop();
  }

  function retryFailed() {
    queue.forEach(function (i) {
      if (i.status === 'err') { i.status = 'wait'; i.error = null; i.loaded = 0; i.offset = 0; }
    });
    batchNotified = false;
    renderQueue();
    pump();
  }

  /* ---------------------------------------------------------------
     5. Lightbox
     --------------------------------------------------------------- */

  function openLightbox(index) {
    state.lbIndex = index;
    $('#lb').hidden = false;
    document.body.style.overflow = 'hidden';
    showLightbox();
  }

  function closeLightbox() {
    $('#lb').hidden = true;
    $('#lb-stage').innerHTML = '';
    document.body.style.overflow = '';
    state.lbIndex = -1;
  }

  function showLightbox() {
    var list = visibleItems();
    if (state.lbIndex < 0 || state.lbIndex >= list.length) return closeLightbox();
    var f = list[state.lbIndex];
    var stage = $('#lb-stage');
    stage.innerHTML = '';

    if (isVideo(f)) {
      var frame = document.createElement('iframe');
      frame.src = 'https://drive.google.com/file/d/' + f.id + '/preview';
      frame.allow = 'autoplay; fullscreen';
      frame.setAttribute('allowfullscreen', '');
      stage.appendChild(frame);
    } else {
      var img = document.createElement('img');
      img.alt = 'Zdjęcie od ' + guestOf(f);
      img.src = state.localThumbs[f.id] || (THUMB + f.id + '&sz=w1600');
      img.dataset.tries = '0';
      img.dataset.fid = f.id;
      img.onerror = retryThumb;
      stage.appendChild(img);
    }

    var when = f.createdTime ? new Date(f.createdTime) : null;
    $('#lb-meta').textContent = guestOf(f) + (when ? ' · ' + when.toLocaleString('pl-PL', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : '') + ' · ' + (state.lbIndex + 1) + '/' + list.length;

    $('#lb-dl').href = 'https://drive.google.com/uc?export=download&id=' + f.id;
    $('#lb-del').hidden = !isMine(f);
  }

  function lbMove(delta) {
    var list = visibleItems();
    var next = state.lbIndex + delta;
    if (next < 0 || next >= list.length) return;
    state.lbIndex = next;
    showLightbox();
    if (next > list.length - 6) loadMore();
  }

  function deleteCurrent() {
    var list = visibleItems();
    var f = list[state.lbIndex];
    if (!f || !isMine(f)) return;
    if (!confirm('Usunąć to zdjęcie z galerii?')) return;

    drive('https://www.googleapis.com/drive/v3/files/' + f.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      delete state.ids[f.id];
      state.items = state.items.filter(function (x) { return x.id !== f.id; });
      log('delete', f.name);
      toast('Zdjęcie usunięte.');
      render();
      var after = visibleItems();
      if (!after.length) closeLightbox();
      else { state.lbIndex = Math.min(state.lbIndex, after.length - 1); showLightbox(); }
    }).catch(function (e) {
      toast('Nie udało się usunąć zdjęcia.', true);
      log('error', 'delete: ' + e.message);
    });
  }

  /* ---------------------------------------------------------------
     6. Drobiazgi UI
     --------------------------------------------------------------- */

  function toast(msg, isErr) {
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, isErr ? 5000 : 3000);
  }

  function askName(force) {
    var modal = $('#name-modal');
    var input = $('#nm-input');
    if (!force && state.guest) return;
    if (state.guest) {
      $('#nm-title').textContent = 'Twoje imię';
      $('#nm-text').textContent = 'Pod tym imieniem podpisujemy Twoje zdjęcia.';
      input.value = state.guest;
    }
    modal.hidden = false;
    setTimeout(function () { input.focus(); }, 120);
  }

  function saveName() {
    var v = $('#nm-input').value.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (v.length < 2) { $('#nm-err').hidden = false; return; }
    $('#nm-err').hidden = true;
    state.guest = v;
    store.set('guest', v);
    $('#who').textContent = v;
    $('#name-modal').hidden = true;
    log('hello', 'imię: ' + v);
  }

  function setFilter(filter) {
    state.filter = filter;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('is-active', c.dataset.filter === filter);
    });
    render();
  }

  /* ---------------------------------------------------------------
     7. Start
     --------------------------------------------------------------- */

  function init() {
    $('#couple').textContent = CFG.coupleNames || 'Nasze wesele';
    $('#wdate').textContent = CFG.weddingDate || '';
    $('#welcome').textContent = CFG.welcomeText || '';
    if (state.guest) $('#who').textContent = state.guest;

    if (!API || API.indexOf('script.google.com') < 0) {
      toast('Brak adresu backendu — uzupełnij apiUrl w config.js', true);
      return;
    }

    $('#btn-pick').addEventListener('click', function () {
      if (!state.guest) { askName(false); return; }
      $('#file-pick').click();
    });
    $('#btn-camera').addEventListener('click', function () {
      if (!state.guest) { askName(false); return; }
      $('#file-cam').click();
    });
    $('#file-pick').addEventListener('change', function (e) {
      enqueue(e.target.files); e.target.value = '';
    });
    $('#file-cam').addEventListener('change', function (e) {
      enqueue(e.target.files); e.target.value = '';
    });

    $('#btn-name').addEventListener('click', function () { askName(true); });
    $('#nm-save').addEventListener('click', saveName);
    $('#nm-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveName(); });

    $('#btn-refresh').addEventListener('click', function () {
      refreshTop().then(function () { toast('Galeria odświeżona.'); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.addEventListener('click', function () { setFilter(c.dataset.filter); });
    });

    $('#up-close').addEventListener('click', function () { $('#uploads').hidden = true; });
    $('#up-retry').addEventListener('click', retryFailed);

    $('#lb-close').addEventListener('click', closeLightbox);
    $('#lb-prev').addEventListener('click', function () { lbMove(-1); });
    $('#lb-next').addEventListener('click', function () { lbMove(1); });
    $('#lb-del').addEventListener('click', deleteCurrent);

    document.addEventListener('keydown', function (e) {
      if ($('#lb').hidden) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lbMove(-1);
      if (e.key === 'ArrowRight') lbMove(1);
    });

    // Gesty na telefonie
    var tx = 0, ty = 0;
    $('#lb-stage').addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      tx = e.touches[0].clientX; ty = e.touches[0].clientY;
    }, { passive: true });
    $('#lb-stage').addEventListener('touchend', function (e) {
      if (!e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - tx;
      var dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) lbMove(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    }, { passive: true });

    // Desktop: przeciaganie plikow i wklejanie ze schowka
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); document.body.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); document.body.classList.remove('drag-over');
      });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        if (!state.guest) { askName(false); return; }
        enqueue(e.dataTransfer.files);
      }
    });
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      if (!state.guest) { askName(false); return; }
      enqueue(e.clipboardData.files);
    });

    // Doladowywanie przy przewijaniu
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) loadMore();
      }, { rootMargin: '600px' }).observe($('#sentinel'));
    }

    // Sygnalizacja braku sieci
    function netState() { $('#offline').hidden = navigator.onLine !== false; }
    window.addEventListener('online', function () { netState(); refreshTop(); pump(); });
    window.addEventListener('offline', netState);
    netState();

    // Ostrzezenie przed zamknieciem karty w trakcie wysylki
    window.addEventListener('beforeunload', function (e) {
      if (queue.some(function (i) { return i.status === 'up' || i.status === 'wait'; })) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Odswiezanie galerii
    setInterval(function () {
      if (document.visibilityState === 'visible') refreshTop();
    }, (CFG.galleryRefreshSec || 20) * 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshTop();
    });

    // Start
    loadFirstPage()
      .then(function () {
        if (!state.guest) askName(false);
        log('open', 'start');
      })
      .catch(function (err) {
        toast('Nie udało się wczytać galerii: ' + friendlyError(err), true);
        log('error', 'init: ' + (err && err.message));
      });

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* nieistotne */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

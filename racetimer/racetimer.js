// PO Race Timer — times an Archipelago multiworld race from one window.
//
// How it works
//   The window joins the room as a "TextOnly" client under the user's own slot name. That is
//   a second connection on the slot (next to the real game client), which Archipelago allows,
//   and it gets every broadcast the game client gets: the !countdown ticks and the "Goal"
//   message the server sends the moment a player's client reports the win.
//
//   One person is the HOST. Their window is the stopwatch of record: it stamps the start when
//   the countdown hits GO (or when they press Start now), stamps every Goal as it arrives, and
//   lets them DNF a player or set a time by hand for someone whose client dropped. Nothing a
//   player's own connection does (disconnect, reconnect, swap emulators) touches the record.
//
//   Everyone else with the launcher is a VIEWER. The host writes the whole race record to the
//   room's data storage (one key per seed) and viewers subscribe to it, so their windows show
//   the same start time, clock and results live, and anyone who opens the window late just
//   reads the current record. The record also lives in the server's save, so it survives
//   everyone closing. Players without the launcher see the host's chat announcements instead.
//
// Protocol used (docs/network protocol.md in the Archipelago repo):
//   RoomInfo → Connect(tags TextOnly) → Connected / ConnectionRefused
//   PrintJSON type Countdown / Goal        Say "!countdown N"
//   Set / SetNotify / Get → SetReply / Retrieved
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORE_KEY_PREFIX = 'po_race:';            // room data-storage key, one per seed
  const CLIENT_STATUS_GOAL = 30;                  // ClientStatus.CLIENT_GOAL
  const LS = {                                     // localStorage keys (shared with other windows: same file:// origin)
    server: 'poRaceServer', slot: 'poRaceSlot', uuid: 'poRaceUuid',
    countdown: 'poRaceCountdown', announce: 'poRaceAnnounce',
  };

  // ---------------------------------------------------------------- state
  const myUuid = localStorage.getItem(LS.uuid) || (() => {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem(LS.uuid, id);
    return id;
  })();

  let ws = null;
  let wantConnected = false;        // user pressed Connect and has not pressed Disconnect
  let candidates = [];              // ws/wss URLs still to try for this connect attempt
  let reconnectTimer = null;
  let countdownWatchdog = null;

  const room = { seed: null, version: null, server: null };
  let me = { team: null, slot: null, name: null };
  let players = [];                 // [{ key, team, slot, name, alias, game }]
  const playerByKey = new Map();

  // The race record. Shape is what gets written to the server, so keep it plain JSON.
  //   host:      { uuid, name }            who holds the stopwatch
  //   startedAt: ms epoch on the host's clock, or null
  //   results:   { "team-slot": { status: 'finished'|'dnf', finishedAt, elapsed, source, note } }
  let race = freshRace();
  let armed = false;                // host pressed Start and is waiting for the countdown to hit 0
  const provisional = new Map();    // viewer-side Goal stamps shown until the host's record lands

  function freshRace() { return { v: 1, host: null, startedAt: null, results: {}, updatedAt: 0 }; }
  const isHost = () => !!(race.host && race.host.uuid === myUuid);
  const storeKey = () => STORE_KEY_PREFIX + (room.seed || 'unknown');
  const keyOf = (team, slot) => `${team}-${slot}`;

  // ---------------------------------------------------------------- helpers
  function log(text, isErr) {
    const line = document.createElement('div');
    if (isErr) line.className = 'err';
    const t = new Date();
    line.textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  ${text}`;
    const logEl = $('log');
    logEl.appendChild(line);
    while (logEl.childElementCount > 60) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ms → "H:MM:SS.cc" (hours only once there are any)
  function fmt(ms, withFrac = true) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    ms = Math.max(0, Math.round(ms));
    const cs = Math.floor((ms % 1000) / 10);
    let s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const core = (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
    return withFrac ? `${core}.${String(cs).padStart(2, '0')}` : core;
  }

  // "1:23:45.67" / "23:45" / "45" / "1h23m" → ms, or null when it doesn't parse
  function parseTime(text) {
    if (!text) return null;
    text = String(text).trim();
    let m = text.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/i);
    if (m && (m[1] || m[2] || m[3]) && /[hms]/i.test(text)) {
      return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
    }
    const parts = text.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0) || parts.length > 3) return null;
    while (parts.length < 3) parts.unshift(0);
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }

  function nameOf(key) {
    const p = playerByKey.get(key);
    return p ? (p.alias || p.name) : key;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify([obj]));
    return true;
  }

  function say(text) {
    if (!$('chk-announce').checked) return;
    send({ cmd: 'Say', text: `[PO Timer] ${text}` });
  }

  // ---------------------------------------------------------------- connection
  function setConn(state, text) {
    $('conn-dot').className = 'dot' + (state ? ' ' + state : '');
    $('conn-text').textContent = text;
  }

  function urlCandidates(input) {
    input = input.trim();
    if (!input) return [];
    if (/^wss?:\/\//i.test(input)) return [input];
    // No scheme typed: archipelago.gg is TLS, most self-hosted rooms are plain ws. Try both.
    return [`wss://${input}`, `ws://${input}`];
  }

  function connect() {
    const serverText = $('in-server').value;
    const slot = $('in-slot').value.trim();
    if (!serverText.trim() || !slot) { log('Server and slot name are both needed.', true); return; }
    localStorage.setItem(LS.server, serverText.trim());
    localStorage.setItem(LS.slot, slot);
    wantConnected = true;
    candidates = urlCandidates(serverText);
    tryNext();
  }

  function tryNext() {
    if (!wantConnected) return;
    if (!candidates.length) { scheduleReconnect(); return; }
    const url = candidates.shift();
    setConn('busy', `Connecting ${url.replace(/^wss?:\/\//, '')}…`);
    let opened = false;
    try { ws = new WebSocket(url); } catch (e) { log(`Bad address: ${e.message}`, true); tryNext(); return; }
    ws.onopen = () => { opened = true; room.server = url; candidates = []; setConn('busy', 'Joining room…'); };
    ws.onmessage = (ev) => { let msgs; try { msgs = JSON.parse(ev.data); } catch { return; } for (const m of msgs) handle(m); };
    ws.onerror = () => { /* onclose follows and carries the decision */ };
    ws.onclose = (ev) => {
      ws = null;
      if (!opened) { tryNext(); return; }            // this scheme failed — try the other one
      setConn('err', 'Disconnected');
      if (wantConnected) { log(`Connection lost (${ev.code}). Reconnecting…`, true); candidates = urlCandidates(room.server); scheduleReconnect(); }
      else log('Disconnected.');
      render();
    };
  }

  function scheduleReconnect() {
    if (!wantConnected) return;
    if (!candidates.length) { candidates = urlCandidates($('in-server').value); }
    setConn('err', 'Could not connect — retrying…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(tryNext, 4000);
  }

  function disconnect() {
    wantConnected = false;
    clearTimeout(reconnectTimer);
    if (ws) ws.close();
    ws = null;
    setConn('', 'Not connected');
    render();
  }

  function sendConnect() {
    send({
      cmd: 'Connect',
      password: $('in-password').value,
      game: '',                                 // TextOnly: no game, no version check for it
      name: $('in-slot').value.trim(),
      uuid: myUuid,
      version: room.version,                    // echo what the server told us it runs
      items_handling: 0b111,                    // same as Archipelago's own text client
      tags: ['TextOnly'],
      slot_data: false,
    });
  }

  // ---------------------------------------------------------------- packets
  function handle(m) {
    switch (m.cmd) {
      case 'RoomInfo':
        room.seed = m.seed_name || null;
        room.version = m.version;
        sendConnect();
        break;

      case 'ConnectionRefused':
        log(`Refused: ${(m.errors || []).join(', ')}`, true);
        setConn('err', 'Refused');
        wantConnected = false;                   // a wrong password won't fix itself on retry
        if (ws) ws.close();
        break;

      case 'Connected':
        me = { team: m.team, slot: m.slot, name: null };
        setPlayers(m.players || [], m.slot_info || {});
        me.name = nameOf(keyOf(me.team, me.slot));
        setConn('on', `Connected as ${me.name}`);
        $('room-meta').textContent = room.seed ? `seed ${room.seed}` : '';
        log(`Joined. ${players.length} player${players.length === 1 ? '' : 's'} in the room.`);
        // Pull the current record and subscribe to changes.
        send({ cmd: 'SetNotify', keys: [storeKey()] });
        send({ cmd: 'Get', keys: [storeKey(), ...players.map((p) => `_read_client_status_${p.team}_${p.slot}`)] });
        break;

      case 'RoomUpdate':
        if (m.players) setPlayers(m.players, null);
        break;

      case 'PrintJSON':
        onPrint(m);
        break;

      case 'Retrieved':
        onRetrieved(m.keys || {});
        break;

      case 'SetReply':
        if (m.key === storeKey()) adoptRemote(m.value);
        break;
    }
    render();
  }

  function setPlayers(list, slotInfo) {
    const keep = [];
    for (const p of list) {
      const key = keyOf(p.team, p.slot);
      const info = slotInfo ? slotInfo[p.slot] : null;
      if (info && info.type === 2) continue;      // item-link groups are not racers
      const prev = playerByKey.get(key);
      keep.push({ key, team: p.team, slot: p.slot, name: p.name, alias: p.alias,
        game: (info && info.game) || (prev && prev.game) || '' });
    }
    players = keep;
    playerByKey.clear();
    for (const p of players) playerByKey.set(p.key, p);
  }

  function onPrint(m) {
    if (m.type === 'Countdown') {
      const n = m.countdown;
      $('clock-sub').textContent = n > 0 ? `COUNTDOWN  ${n}` : 'GO';
      if (n === 0 && isHost() && armed) startRace(Date.now(), 'countdown');
      return;
    }
    if (m.type === 'Goal') {
      const key = keyOf(m.team, m.slot);
      const now = Date.now();
      if (isHost()) recordFinish(key, now, 'goal');
      else if (race.startedAt && !race.results[key]) provisional.set(key, now - race.startedAt);
      log(`${nameOf(key)} reached their goal.`);
    }
  }

  function onRetrieved(keys) {
    if (Object.prototype.hasOwnProperty.call(keys, storeKey())) adoptRemote(keys[storeKey()]);
    // Anyone already at goal when we joined (host reconnecting after a drop, say) — flag them
    // so the host can set the time by hand instead of them silently showing as still running.
    if (isHost()) {
      let added = false;
      for (const p of players) {
        const st = keys[`_read_client_status_${p.team}_${p.slot}`];
        if (st === CLIENT_STATUS_GOAL && !race.results[p.key]) {
          race.results[p.key] = { status: 'finished', finishedAt: null, elapsed: null, source: 'status', note: 'goaled while timer was away — set time' };
          log(`${nameOf(p.key)} is already at goal; set their time by hand.`);
          added = true;
        }
      }
      if (added) publish();
    }
  }

  function adoptRemote(value) {
    if (!value || typeof value !== 'object') {
      if (!isHost()) race = freshRace();          // record was reset / never written
      provisional.clear();
      return;
    }
    if (value.host && value.host.uuid === myUuid) {
      // Our own record coming back: the reply to a write, or a restore after the window was
      // reopened. If we changed things while the connection was down, ours is newer — push it.
      if (isHost() && race.updatedAt > (value.updatedAt || 0)) { publish(); return; }
      race = value;
    } else {
      race = value;                               // someone else hosts; mirror them
      armed = false;
    }
    for (const k of Object.keys(race.results || {})) provisional.delete(k);
  }

  // ---------------------------------------------------------------- host actions
  function publish() {
    race.updatedAt = Date.now();
    send({ cmd: 'Set', key: storeKey(), default: {}, want_reply: true, operations: [{ operation: 'replace', value: race }] });
  }

  function becomeHost() {
    if (race.host && race.host.uuid !== myUuid && race.startedAt) {
      if (!confirm(`${race.host.name || 'Someone'} is hosting this race. Take over the stopwatch?`)) return;
    }
    race.host = { uuid: myUuid, name: me.name || $('in-slot').value.trim() };
    publish();
    log('You are hosting this race.');
  }

  function armStart() {
    if (!isHost()) return;
    if (race.startedAt) { log('Race already started. Reset first to start again.', true); return; }
    const n = Math.max(0, Math.min(60, parseInt($('in-countdown').value, 10) || 0));
    localStorage.setItem(LS.countdown, String(n));
    if (n === 0) { startRace(Date.now(), 'manual'); return; }
    armed = true;
    send({ cmd: 'Say', text: `!countdown ${n}` });
    $('clock-sub').textContent = 'COUNTDOWN SENT — starts on GO';
    log(`Countdown ${n}s sent. Start is recorded when the server says GO.`);
    clearTimeout(countdownWatchdog);
    countdownWatchdog = setTimeout(() => {
      if (armed) { armed = false; log('No GO arrived from the server. Use "Start now" instead.', true); render(); }
    }, (n + 6) * 1000);
  }

  function startRace(at, how) {
    armed = false;
    clearTimeout(countdownWatchdog);
    race.startedAt = at;
    // A Goal that arrived before this moment keeps elapsed = null ("before start"); the host sets it by hand.
    publish();
    say('GO! Race started.');
    log(`Race started (${how}).`);
  }

  function recordFinish(key, at, source) {
    if (race.results[key] && race.results[key].status === 'finished' && race.results[key].elapsed != null) return; // already have a time
    const elapsed = race.startedAt ? at - race.startedAt : null;
    race.results[key] = { status: 'finished', finishedAt: at, elapsed, source, note: race.startedAt ? '' : 'before start' };
    publish();
    const place = placeOf(key);
    say(elapsed != null ? `${nameOf(key)} finished — ${fmt(elapsed)}${place ? ` (${ordinal(place)})` : ''}` : `${nameOf(key)} finished (before the start was recorded)`);
    maybeAnnounceFinal();
  }

  function setTimeByHand(key) {
    const cur = race.results[key] && race.results[key].elapsed;
    const text = prompt(`Time for ${nameOf(key)} (H:MM:SS or MM:SS):`, cur != null ? fmt(cur) : '');
    if (text == null) return;
    const ms = parseTime(text);
    if (ms == null) { log(`Could not read "${text}" as a time.`, true); return; }
    race.results[key] = { status: 'finished', finishedAt: race.startedAt ? race.startedAt + ms : null, elapsed: ms, source: 'typed', note: 'set by host' };
    publish();
    say(`${nameOf(key)} — ${fmt(ms)} (entered by host)`);
    maybeAnnounceFinal();
  }

  function markDnf(key) {
    race.results[key] = { status: 'dnf', finishedAt: Date.now(), elapsed: null, source: 'manual', note: '' };
    publish();
    say(`${nameOf(key)} — DNF`);
    maybeAnnounceFinal();
  }

  function undo(key) {
    delete race.results[key];
    publish();
    log(`Cleared ${nameOf(key)}.`);
  }

  function resetRace() {
    if (!confirm('Clear the start time and every result for this seed?')) return;
    race = freshRace();
    race.host = { uuid: myUuid, name: me.name };
    armed = false;
    provisional.clear();
    publish();
    log('Race reset.');
  }

  // ---------------------------------------------------------------- results
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function standings() {
    const rows = players.map((p) => ({ key: p.key, name: p.alias || p.name, r: race.results[p.key] || null }));
    const finished = rows.filter((x) => x.r && x.r.status === 'finished' && x.r.elapsed != null).sort((a, b) => a.r.elapsed - b.r.elapsed);
    const untimed = rows.filter((x) => x.r && x.r.status === 'finished' && x.r.elapsed == null);
    const dnf = rows.filter((x) => x.r && x.r.status === 'dnf');
    return { finished, untimed, dnf, open: rows.filter((x) => !x.r) };
  }

  function placeOf(key) {
    const i = standings().finished.findIndex((x) => x.key === key);
    return i < 0 ? 0 : i + 1;
  }

  function allDone() { return players.length > 0 && players.every((p) => race.results[p.key]); }

  function resultsText() {
    const s = standings();
    const lines = [`Race results${room.seed ? ` — seed ${room.seed}` : ''}`];
    s.finished.forEach((x, i) => lines.push(`${i + 1}. ${x.name} — ${fmt(x.r.elapsed)}`));
    s.untimed.forEach((x) => lines.push(`•  ${x.name} — finished, no time`));
    s.dnf.forEach((x) => lines.push(`DNF — ${x.name}`));
    return lines.join('\n');
  }

  function maybeAnnounceFinal() {
    if (!allDone()) return;
    const s = standings();
    const parts = s.finished.map((x, i) => `${i + 1}. ${x.name} ${fmt(x.r.elapsed, false)}`);
    if (s.dnf.length) parts.push(`DNF: ${s.dnf.map((x) => x.name).join(', ')}`);
    say(`Race over — ${parts.join('  |  ')}`);
  }

  // ---------------------------------------------------------------- render
  function tickClock() {
    const clock = $('clock');
    const now = Date.now();
    let ms = 0;
    if (race.startedAt) {
      const s = standings();
      ms = allDone()
        ? (s.finished.length ? s.finished[s.finished.length - 1].r.elapsed : 0)   // frozen at the last finish
        : now - race.startedAt;
    }
    const text = fmt(ms);
    const dot = text.lastIndexOf('.');
    clock.innerHTML = `${text.slice(0, dot)}<span class="frac">${text.slice(dot)}</span>`;
    clock.className = 'clock' + (armed ? ' armed' : allDone() && race.startedAt ? ' done' : '');
    // Live times in the table without re-rendering the rows
    for (const p of players) {
      const cell = document.querySelector(`[data-live="${p.key}"]`);
      if (cell && race.startedAt) cell.textContent = fmt(now - race.startedAt, false);
    }
  }

  function render() {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN && me.team != null);
    $('connect-panel').hidden = connected;
    $('btn-disconnect').hidden = !connected;
    $('btn-connect').textContent = wantConnected ? 'Cancel' : 'Connect';
    $('players-panel').hidden = !connected;
    $('host-panel').hidden = !(connected && isHost());
    $('viewer-panel').hidden = !(connected && !isHost());

    if (connected && !isHost()) {
      $('viewer-text').textContent = race.host ? `Hosted by ${race.host.name || 'another player'} — this window mirrors their stopwatch.` : 'No host yet. Whoever holds the stopwatch presses the button.';
      $('btn-host').textContent = race.host ? 'Take over hosting' : 'Host this race';
    }
    if (connected && isHost()) {
      $('btn-start').disabled = !!race.startedAt || armed;
      $('btn-start-now').disabled = !!race.startedAt;
    }

    // Sub-line under the clock
    if (!connected) $('clock-sub').textContent = wantConnected ? 'Connecting…' : 'Connect to a room to begin';
    else if (armed) { /* countdown text is written by onPrint */ }
    else if (!race.startedAt) $('clock-sub').textContent = isHost() ? 'READY — press Start race' : 'WAITING FOR HOST';
    else if (allDone()) $('clock-sub').textContent = 'RACE OVER';
    else { const s = standings(); $('clock-sub').textContent = `RUNNING — ${s.open.length} still going`; }

    // Player table
    const body = $('players-body');
    body.innerHTML = '';
    for (const p of players) {
      const r = race.results[p.key];
      const prov = provisional.get(p.key);
      const tr = document.createElement('tr');
      let status, time, cls;
      if (r && r.status === 'dnf') { status = 'DNF'; time = '—'; cls = 'dnf'; }
      else if (r && r.status === 'finished') {
        const place = placeOf(p.key);
        status = r.elapsed != null ? `Finished${place ? ` · ${ordinal(place)}` : ''}` : 'Finished · no time';
        time = fmt(r.elapsed); cls = 'finished';
        if (r.note) status += ` (${r.note})`;
      }
      else if (prov != null) { status = 'Finished · awaiting host'; time = fmt(prov); cls = 'provisional'; }
      else if (race.startedAt) { status = 'Running'; time = ''; cls = 'running'; }
      else { status = 'Waiting'; time = '—'; cls = ''; }
      tr.className = cls;
      const liveAttr = cls === 'running' ? ` data-live="${p.key}"` : '';
      tr.innerHTML = `<td>${esc(p.alias || p.name)}</td><td class="game">${esc(p.game)}</td><td class="status">${esc(status)}</td><td class="num"${liveAttr}>${esc(time)}</td><td class="actions"></td>`;
      if (isHost()) {
        const act = tr.querySelector('.actions');
        if (!r) {
          act.appendChild(mkBtn('Finish now', () => recordFinish(p.key, Date.now(), 'manual'), !race.startedAt));
          act.appendChild(mkBtn('Set time…', () => setTimeByHand(p.key)));
          act.appendChild(mkBtn('DNF', () => markDnf(p.key)));
        } else {
          if (r.elapsed == null && r.status === 'finished') act.appendChild(mkBtn('Set time…', () => setTimeByHand(p.key)));
          act.appendChild(mkBtn('Undo', () => undo(p.key)));
        }
      }
      body.appendChild(tr);
    }

    // Results board once everyone is accounted for
    const done = connected && allDone();
    $('results-panel').hidden = !done;
    if (done) {
      const s = standings();
      const list = $('results-list');
      list.innerHTML = '';
      s.finished.forEach((x, i) => list.appendChild(mkResult(`${i + 1}.`, x.name, fmt(x.r.elapsed), x.r.source === 'typed' ? 'entered by host' : '')));
      for (const x of s.untimed) list.appendChild(mkResult('•', x.name, 'no time', ''));
      for (const x of s.dnf) list.appendChild(mkResult('', x.name, 'DNF', '', true));
    }
    tickClock();
  }

  function mkBtn(label, onClick, disabled) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = label; b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }
  function mkResult(place, name, time, note, dnf) {
    const li = document.createElement('li');
    if (dnf) li.className = 'r-dnf';
    li.innerHTML = `<span class="r-place">${esc(place)}</span><span class="r-name">${esc(name)}${note ? ` <span class="r-note">${esc(note)}</span>` : ''}</span><span class="r-time">${esc(time)}</span>`;
    return li;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------------------------------------------------------------- wiring
  $('in-server').value = localStorage.getItem(LS.server) || '';
  $('in-slot').value = localStorage.getItem(LS.slot) || '';
  $('in-countdown').value = localStorage.getItem(LS.countdown) || '10';
  $('chk-announce').checked = localStorage.getItem(LS.announce) !== '0';
  $('chk-announce').addEventListener('change', (e) => localStorage.setItem(LS.announce, e.target.checked ? '1' : '0'));

  $('btn-connect').addEventListener('click', () => (wantConnected ? disconnect() : connect()));
  for (const id of ['in-server', 'in-slot', 'in-password']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  $('btn-host').addEventListener('click', becomeHost);
  $('btn-start').addEventListener('click', armStart);
  $('btn-start-now').addEventListener('click', () => isHost() && !race.startedAt && startRace(Date.now(), 'manual'));
  $('btn-reset').addEventListener('click', resetRace);
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(resultsText()); log('Results copied.'); }
    catch { log('Clipboard blocked — select the list and copy it instead.', true); }
  });

  $('btn-disconnect').addEventListener('click', disconnect);

  // Pre-fill from the seed the launcher opened. main.js reads the .aplttp's manifest and passes
  // the room as the query string when this window opens, and pushes a fresh one into an open
  // window when another seed is launched. A patch from a hosted room carries the host:port; a
  // self-hosted seed only carries the slot name, so the last-used address is kept in that case.
  function applyRoomHint(hint) {
    if (!hint || typeof hint !== 'object' || typeof hint.slot !== 'string' || !hint.slot) return;
    if (wantConnected) { log(`Launched ${hint.file || 'another seed'} — disconnect first to switch rooms.`); return; }
    if (hint.server) $('in-server').value = hint.server;
    $('in-slot').value = hint.slot;
    log(`Filled in from ${hint.file || 'the launched seed'}${hint.server ? '' : ' (patch has no room address — kept the last one)'}.`);
  }
  window.applyPoRoomHint = applyRoomHint;

  setInterval(tickClock, 47);
  render();
  log('Ready. Enter the room address and your slot name.');
  const q = new URLSearchParams(location.search);
  if (q.get('slot')) applyRoomHint({ server: q.get('server') || '', slot: q.get('slot'), file: q.get('file') || '' });
})();

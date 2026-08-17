// ═══════════════════════════════════════════════════════════════
//  TicTacGrow — WebSocket Server
//  Deploy to Render.com (free tier) or any Node.js host
//
//  Required environment variables (set in Render dashboard):
//    SUPABASE_URL               — your Supabase project URL
//    SUPABASE_SERVICE_ROLE_KEY  — service role key (SECRET — server only)
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const wss  = new WebSocket.Server({ port: PORT });
console.log(`TicTacGrow server listening on port ${PORT}`);

// Supabase is optional — if env vars aren't set, the server still runs
// fully (guest-only, no stats persistence, no room-cap bypass for
// signed-in users since nobody can sign in without it configured).
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log('Supabase connected — stats & auth enabled.');
} else {
  console.log('Supabase env vars not set — running in guest-only mode.');
}

// ── Active rooms ──────────────────────────────────────────────
// roomCode (6-char uppercase) → { p1, p2, state, code, rematchVotes, isGuestRoom }
const rooms = {};

// Guest room cap — protects free-tier server resources.
// Signed-in hosts are NOT counted against this at all.
const MAX_GUEST_ROOMS = 20;
let guestRoomCount = 0;

// ═══════════════════════════════════════════════════════════════
//  GAME LOGIC  (authoritative — mirrors the client)
// ═══════════════════════════════════════════════════════════════

const K   = (x, y) => `${x},${y}`;
const unK = k => { const [x,y] = k.split(',').map(Number); return {x,y}; };

function getC(cells, x, y) {
  return cells[K(x,y)] || {hasBox:false, blackedOut:false, symbol:null};
}
function setC(cells, x, y, u) {
  cells[K(x,y)] = {...getC(cells,x,y), ...u};
}

function freshState() {
  const cells = {};
  for (let x=0; x<3; x++)
    for (let y=0; y<3; y++)
      setC(cells, x, y, {hasBox:true, blackedOut:false, symbol:null});
  return {cells, curP:1, over:false, winCells:[]};
}

function isAdjOrDiag(ax,ay,bx,by) {
  return Math.abs(ax-bx)<=1 && Math.abs(ay-by)<=1 && !(ax===bx && ay===by);
}

function canNo(cells, x, y) {
  if (getC(cells,x,y).blackedOut) return false;
  for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]])
    if (getC(cells, x+dx, y+dy).blackedOut) return false;
  return true;
}

function checkWin(cells, sym) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const k in cells) {
    const c = cells[k];
    if (c.symbol !== sym || c.blackedOut) continue;
    const {x,y} = unK(k);
    for (const [dx,dy] of dirs) {
      const run = [{x,y}];
      for (let i=1; i<3; i++) {
        const nc = getC(cells, x+dx*i, y+dy*i);
        if (nc.symbol===sym && !nc.blackedOut) run.push({x:x+dx*i, y:y+dy*i});
        else break;
      }
      if (run.length===3) return run;
    }
  }
  return null;
}

// Returns {ok:true} or {ok:false, error:string}
function applyMove(state, role, data) {
  if (state.over)                        return {ok:false, error:'Game is already over'};
  const expectedP = role==='host' ? 1 : 2;
  if (state.curP !== expectedP)          return {ok:false, error:'Not your turn'};

  const {cells} = state;
  const sym = state.curP===1 ? 'X' : 'O';

  // ── TIC ──────────────────────────────────────────────────
  if (data.action === 'tic') {
    const {x,y} = data;
    const c = getC(cells,x,y);
    if (!c.hasBox)      return {ok:false, error:'No box at that position'};
    if (c.blackedOut)   return {ok:false, error:'Cell is blacked out'};
    if (c.symbol)       return {ok:false, error:'Cell already has a symbol'};
    setC(cells,x,y,{symbol:sym});
    const winRun = checkWin(cells,sym);
    if (winRun) { state.over=true; state.winCells=winRun; }
    else state.curP = state.curP===1 ? 2 : 1;
    return {ok:true};
  }

  // ── GROW ─────────────────────────────────────────────────
  if (data.action === 'grow') {
    const {ox,oy,placements} = data;
    if (!Array.isArray(placements) || placements.length<1 || placements.length>2)
      return {ok:false, error:'Grow requires 1 or 2 placements'};
    if (!getC(cells,ox,oy).hasBox)
      return {ok:false, error:'Grow origin must be a full box'};
    const seen = new Set();
    for (const p of placements) {
      const key = K(p.x,p.y);
      if (seen.has(key))                          return {ok:false, error:'Duplicate placement'};
      if (!isAdjOrDiag(ox,oy,p.x,p.y))           return {ok:false, error:`(${p.x},${p.y}) is not adjacent/diagonal to origin`};
      if (getC(cells,p.x,p.y).hasBox)             return {ok:false, error:`(${p.x},${p.y}) already has a box`};
      seen.add(key);
    }
    for (const p of placements) setC(cells,p.x,p.y,{hasBox:true,blackedOut:false,symbol:null});
    state.curP = state.curP===1 ? 2 : 1;
    return {ok:true};
  }

  // ── NO ───────────────────────────────────────────────────
  // Blacking out a cell removes it from play but keeps its symbol on
  // record (checkWin/canGrow/canNo all key off `blackedOut`, not the
  // presence of a symbol) — clients render the old symbol dimmed
  // underneath the scribble so players can still see what was there.
  if (data.action === 'no') {
    const {x,y} = data;
    if (!canNo(cells,x,y))
      return {ok:false, error:'Cannot black out — orthogonally adjacent to an existing blackout'};
    setC(cells,x,y,{blackedOut:true});
    state.curP = state.curP===1 ? 2 : 1;
    return {ok:true};
  }

  return {ok:false, error:'Unknown action: '+data.action};
}

// ═══════════════════════════════════════════════════════════════
//  AUTH — verify a Supabase access token, or treat as guest
// ═══════════════════════════════════════════════════════════════

function genGuestName() {
  return 'Guest-' + Math.floor(1000 + Math.random()*9000);
}

async function resolveUser(token) {
  if (!token || !supabase) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const u = data.user;
    return {
      id: u.id,
      name: u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Player',
    };
  } catch (e) {
    console.error('Auth verify failed:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  STATS / MATCH RECORDING  (signed-in players only)
// ═══════════════════════════════════════════════════════════════

async function recordMatchResult(room, winnerRole, reason) {
  if (!supabase) return;
  const hostUserId  = room.p1?.userId  || null;
  const guestUserId = room.p2?.userId || null;
  if (!hostUserId && !guestUserId) return; // both guests — nothing to persist

  const winnerId = winnerRole==='host' ? hostUserId  : guestUserId;
  const loserId  = winnerRole==='host' ? guestUserId : hostUserId;

  try {
    await supabase.from('matches').insert({
      player1_id: hostUserId,
      player2_id: guestUserId,
      winner_id: winnerId,
      ended_reason: reason,
    });
    await supabase.rpc('record_match_result', { p_winner: winnerId, p_loser: loserId });
  } catch (e) {
    console.error('Supabase match record failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROOM HELPERS
// ═══════════════════════════════════════════════════════════════

function genCode() {
  const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c='';
  for (let i=0; i<6; i++) c += ch[Math.floor(Math.random()*ch.length)];
  return c;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  send(room.p1, data);
  send(room.p2, data);
}

// Call whenever a room is fully torn down, to release its guest-cap slot.
function releaseRoom(code, room) {
  if (room.isGuestRoom) guestRoomCount = Math.max(0, guestRoomCount-1);
  delete rooms[code];
}

// ═══════════════════════════════════════════════════════════════
//  MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleCreate(ws, token) {
  const user = await resolveUser(token);
  ws.userId   = user?.id || null;
  ws.userName = user?.name || genGuestName();

  if (!user) {
    if (guestRoomCount >= MAX_GUEST_ROOMS) {
      send(ws, {type:'error', message:'Guest rooms are full right now — try again shortly, or sign in with Google for unlimited access.'});
      return;
    }
    guestRoomCount++;
  }

  let code;
  let tries = 0;
  do { code = genCode(); tries++; } while (rooms[code] && tries < 100);
  rooms[code] = {p1:ws, p2:null, state:freshState(), code, rematchVotes:new Set(), isGuestRoom:!user};
  ws.roomCode = code;
  ws.role     = 'host';
  send(ws, {type:'created', code});
  console.log(`Room ${code} created by ${ws.userName}${user?' (signed in)':' (guest)'}`);
}

async function handleJoin(ws, rawCode, token) {
  const code = (rawCode||'').trim().toUpperCase().slice(0,6);
  const room = rooms[code];
  if (!room)       { send(ws,{type:'error',message:'Room not found. Check the code.'}); return; }
  if (room.p2)     { send(ws,{type:'error',message:'Room is full.'}); return; }
  if (room.p1===ws){ send(ws,{type:'error',message:'You cannot join your own room.'}); return; }

  const user = await resolveUser(token);
  ws.userId   = user?.id || null;
  ws.userName = user?.name || genGuestName();

  room.p2      = ws;
  ws.roomCode  = code;
  ws.role      = 'guest';
  room.state   = freshState();
  room.rematchVotes = new Set(); // fresh game for both

  send(ws,     {type:'joined',          role:'guest', state:room.state, hostName:room.p1.userName});
  send(room.p1,{type:'opponent-joined', role:'host',  state:room.state, guestName:ws.userName});
  console.log(`Room ${code} — ${ws.userName} joined`);
}

async function handleMove(ws, data) {
  const room = rooms[ws.roomCode];
  if (!room) { send(ws,{type:'error',message:'Not in a room'}); return; }

  const result = applyMove(room.state, ws.role, data);
  if (!result.ok) { send(ws,{type:'error',message:result.error}); return; }

  // Broadcast new state with move info so clients can log it
  const moveInfo = {...data, role:ws.role};
  broadcast(room, {type:'state', state:room.state, move:moveInfo});

  if (room.state.over) {
    const winnerRole = ws.role; // the player who just moved is the one who won
    await recordMatchResult(room, winnerRole, 'win');
  }
}

async function handleResign(ws) {
  const code = ws.roomCode;
  const room = rooms[code];
  if (!room) return;
  if (!room.state.over) {
    const other = room.p1===ws ? room.p2 : room.p1;
    const winnerRole = room.p1===ws ? 'guest' : 'host';
    send(other, {type:'opponent-resigned'});
    await recordMatchResult(room, winnerRole, 'resign');
  }
  if (room.p1===ws) room.p1=null; else room.p2=null;
  if (!room.p1 && !room.p2) releaseRoom(code, room);
  ws.roomCode = null; // prevents handleDisconnect from double-firing
  console.log(`Room ${code} — player resigned`);
}

function handleRematchRequest(ws) {
  const room = rooms[ws.roomCode];
  if (!room || !room.state.over) return;
  if (!room.p1 || !room.p2) { send(ws,{type:'opponent-left'}); return; } // opponent gone
  room.rematchVotes = room.rematchVotes || new Set();
  room.rematchVotes.add(ws.role);
  broadcast(room, {type:'rematch-status', votes: Array.from(room.rematchVotes)});
  if (room.rematchVotes.has('host') && room.rematchVotes.has('guest')) {
    room.state = freshState();
    room.rematchVotes = new Set();
    broadcast(room, {type:'reset', state:room.state});
    console.log(`Room ${room.code} — rematch started`);
  }
}

function handleLeave(ws) {
  const code = ws.roomCode;
  const room = rooms[code];
  if (!room) return;
  const other = room.p1===ws ? room.p2 : room.p1;
  send(other, {type:'opponent-left'});
  if (room.p1===ws) room.p1=null; else room.p2=null;
  if (!room.p1 && !room.p2) releaseRoom(code, room);
  ws.roomCode = null; // prevents handleDisconnect from double-firing
  console.log(`Room ${code} — player left`);
}

async function handleDisconnect(ws) {
  if (!ws.roomCode) return; // already cleaned up by resign/leave
  const code = ws.roomCode;
  const room = rooms[code];
  if (!room) return;
  const other = room.p1===ws ? room.p2 : room.p1;
  if (!room.state.over) {
    // Game was live — treat drop as resign
    const winnerRole = room.p1===ws ? 'guest' : 'host';
    send(other, {type:'opponent-resigned'});
    await recordMatchResult(room, winnerRole, 'resign');
  } else {
    // Game already ended — grey out their rematch option, don't force navigation
    send(other, {type:'opponent-left'});
  }
  if (room.p1===ws) room.p1=null; else room.p2=null;
  if (!room.p1 && !room.p2) {
    releaseRoom(code, room);
    console.log(`Room ${code} cleaned up`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CONNECTION HANDLER
// ═══════════════════════════════════════════════════════════════

wss.on('connection', ws => {
  ws.roomCode = null;
  ws.role     = null;
  ws.userId   = null;
  ws.userName = null;
  ws.isAlive  = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }
    if (data.type==='ping')                 { send(ws,{type:'pong'}); return; }
    if (data.type==='create')               await handleCreate(ws, data.token);
    else if (data.type==='join')            await handleJoin(ws, data.code, data.token);
    else if (data.type==='move')            await handleMove(ws, data);
    else if (data.type==='resign')          await handleResign(ws);
    else if (data.type==='rematch-request') handleRematchRequest(ws);
    else if (data.type==='leave')           handleLeave(ws);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

// Heartbeat: detect dead connections and clean them up
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

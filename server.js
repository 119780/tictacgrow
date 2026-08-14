// ═══════════════════════════════════════════════════════════════
//  TicTacGrow — WebSocket Server
//  Deploy to Render.com (free tier) or any Node.js host
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss  = new WebSocket.Server({ port: PORT });
console.log(`TicTacGrow server listening on port ${PORT}`);

// ── Active rooms ──────────────────────────────────────────────
// roomCode (6-char uppercase) → { p1, p2, state, code }
const rooms = {};

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
  const sym = state.curP===1 ? 'x' : 'o';

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
  if (data.action === 'no') {
    const {x,y} = data;
    if (!canNo(cells,x,y))
      return {ok:false, error:'Cannot black out — orthogonally adjacent to an existing blackout'};
    setC(cells,x,y,{blackedOut:true,symbol:null});
    state.curP = state.curP===1 ? 2 : 1;
    return {ok:true};
  }

  return {ok:false, error:'Unknown action: '+data.action};
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

// ═══════════════════════════════════════════════════════════════
//  MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════

function handleCreate(ws) {
  // Generate unique code
  let code;
  let tries = 0;
  do { code = genCode(); tries++; } while (rooms[code] && tries < 100);
  rooms[code] = {p1:ws, p2:null, state:freshState(), code};
  ws.roomCode = code;
  ws.role     = 'host';
  send(ws, {type:'created', code});
  console.log(`Room ${code} created`);
}

function handleJoin(ws, rawCode) {
  const code = (rawCode||'').trim().toUpperCase().slice(0,6);
  const room = rooms[code];
  if (!room)       { send(ws,{type:'error',message:'Room not found. Check the code.'}); return; }
  if (room.p2)     { send(ws,{type:'error',message:'Room is full.'}); return; }
  if (room.p1===ws){ send(ws,{type:'error',message:'You cannot join your own room.'}); return; }

  room.p2      = ws;
  ws.roomCode  = code;
  ws.role      = 'guest';
  room.state   = freshState(); // fresh game for both

  send(ws,     {type:'joined',          role:'guest', state:room.state});
  send(room.p1,{type:'opponent-joined', role:'host',  state:room.state});
  console.log(`Room ${code} — guest joined`);
}

function handleMove(ws, data) {
  const room = rooms[ws.roomCode];
  if (!room) { send(ws,{type:'error',message:'Not in a room'}); return; }

  const result = applyMove(room.state, ws.role, data);
  if (!result.ok) { send(ws,{type:'error',message:result.error}); return; }

  // Broadcast new state with move info so clients can log it
  const moveInfo = {...data, role:ws.role};
  broadcast(room, {type:'state', state:room.state, move:moveInfo});
}

function handleReset(ws) {
  const room = rooms[ws.roomCode];
  if (!room) return;
  room.state = freshState();
  broadcast(room, {type:'reset', state:room.state});
  console.log(`Room ${room.code} reset`);
}

function handleDisconnect(ws) {
  const room = rooms[ws.roomCode];
  if (!room) return;
  const other = room.p1===ws ? room.p2 : room.p1;
  send(other, {type:'opponent-disconnected'});
  if (room.p1===ws) room.p1=null; else room.p2=null;
  if (!room.p1 && !room.p2) {
    delete rooms[ws.roomCode];
    console.log(`Room ${ws.roomCode} cleaned up`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CONNECTION HANDLER
// ═══════════════════════════════════════════════════════════════

wss.on('connection', ws => {
  ws.roomCode = null;
  ws.role     = null;
  ws.isAlive  = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }
    if (data.type==='ping')   { send(ws,{type:'pong'}); return; }
    if (data.type==='create') handleCreate(ws);
    else if (data.type==='join')  handleJoin(ws, data.code);
    else if (data.type==='move')  handleMove(ws, data);
    else if (data.type==='reset') handleReset(ws);
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

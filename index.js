// ===========================================================================
// MOOMOO.IO WEBSOCKET PROXY - CLOUD VERSION (Matching working proxy-server.js)
// ===========================================================================

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

// Use node-fetch for token generation (more reliable)
let fetch;
try {
    fetch = require('node-fetch');
} catch (e) {
    // Fallback to native fetch in Node 18+
    fetch = globalThis.fetch;
}

// Proxy agents
const { HttpsProxyAgent } = require('https-proxy-agent');
let SocksProxyAgent;
try {
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) {
    console.log('[Proxy] SOCKS support not available');
}

// Configuration
const PORT = process.env.PORT || 8080;
const TOKEN_RATE_WINDOW_MS = 400;  // Throttle token fetches
const DIAL_JITTER_MS = [120, 320]; // Random delay before dialing
const KEEPALIVE_MS = 20000;        // Ping every 20 seconds

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5282.106 Safari/537.36',
    'Origin': 'https://moomoo.io',
    'Referer': 'https://moomoo.io/',
    'Accept-Language': 'en-US,en;q=0.9'
};

// Proxy state
let proxyList = [];
let proxyState = []; // { active, lastTokenAt }
let rrCursor = 0;

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function loadProxies() {
    const proxiesEnv = process.env.PROXIES || '';
    if (!proxiesEnv) {
        console.error('[Proxy] No PROXIES environment variable set!');
        return false;
    }
    
    proxyList = proxiesEnv.split(',').map(p => p.trim()).filter(Boolean);
    
    // Normalize socks5 to socks5h (DNS through proxy)
    proxyList = proxyList.map(p => p.replace(/^socks5:\/\//i, 'socks5h://'));
    
    proxyState = proxyList.map(() => ({ active: 0, lastTokenAt: 0 }));
    
    if (proxyList.length === 0) {
        console.error('[Proxy] No valid proxies found');
        return false;
    }
    
    console.log(`[Proxy] Loaded ${proxyList.length} proxy(ies)`);
    return true;
}

function pickProxyIndex() {
    const n = proxyList.length;
    if (n === 0) return -1;
    
    // Simple round-robin
    const idx = rrCursor % n;
    rrCursor = (rrCursor + 1) % n;
    return idx;
}

function makeAgent(proxyUrl) {
    if (!proxyUrl) return null;
    if (/^socks/i.test(proxyUrl)) {
        if (!SocksProxyAgent) return null;
        return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
}

function getProxyHost(proxyUrl) {
    try {
        const parsed = new URL(proxyUrl);
        return `${parsed.hostname}:${parsed.port}`;
    } catch {
        return 'unknown';
    }
}

// Token generation using node-fetch (matching working version)
async function generateToken(agent, proxyIdx) {
    // Rate limit per proxy
    if (proxyIdx >= 0 && proxyState[proxyIdx]) {
        const until = proxyState[proxyIdx].lastTokenAt + TOKEN_RATE_WINDOW_MS - Date.now();
        if (until > 0) await sleep(until);
        proxyState[proxyIdx].lastTokenAt = Date.now();
    }
    
    try {
        const fetchOptions = {
            headers: BROWSER_HEADERS
        };
        if (agent) {
            fetchOptions.agent = agent;
        }
        
        const resp = await fetch('https://api.moomoo.io/verify', fetchOptions);
        if (!resp.ok) {
            console.error('[Token] Verify request failed:', resp.status);
            return null;
        }
        
        const data = await resp.json();
        const { challenge, salt, maxnumber, signature } = data;
        
        if (!challenge || !salt || maxnumber === undefined) {
            console.error('[Token] Invalid challenge data');
            return null;
        }
        
        console.log(`[Token] Solving challenge, max: ${maxnumber}`);
        
        for (let i = 0; i <= maxnumber; i++) {
            const hash = crypto.createHash('sha256').update(salt + i).digest('hex');
            if (hash === challenge) {
                console.log(`[Token] Solved at: ${i}`);
                const payload = {
                    algorithm: 'SHA-256',
                    challenge,
                    salt,
                    number: i,
                    signature: signature || null,
                    took: 'cloud'
                };
                return 'alt:' + Buffer.from(JSON.stringify(payload)).toString('base64');
            }
        }
        
        console.error('[Token] Failed to solve challenge');
        return null;
    } catch (e) {
        console.error('[Token] Error:', e.message);
        return null;
    }
}

// Load proxies
if (!loadProxies()) {
    console.error('[Proxy] Running without external proxies');
}

// HTTP server for health checks
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            status: 'ok',
            proxies: proxyList.length,
            uptime: process.uptime()
        }));
        return;
    }
    res.writeHead(404);
    res.end('Not found');
});

// WebSocket server
const wss = new WebSocket.Server({ server });

console.log(`[Proxy] Starting on port ${PORT}...`);

wss.on('connection', async (clientSocket, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const region = url.searchParams.get('region');
    const botName = url.searchParams.get('name') || 'SyncBot';
    
    console.log(`[${botName}] New connection, region: ${region}`);
    
    if (!region || !/\.moomoo\.io$/i.test(region)) {
        console.error(`[${botName}] Invalid region. Closing.`);
        clientSocket.close();
        return;
    }
    
    // Pick proxy
    const proxyIdx = pickProxyIndex();
    const proxyUrl = proxyIdx >= 0 ? proxyList[proxyIdx] : null;
    const agent = proxyUrl ? makeAgent(proxyUrl) : null;
    const proxyHost = proxyUrl ? getProxyHost(proxyUrl) : 'direct';
    
    console.log(`[${botName}] Using proxy: ${proxyHost}`);
    
    // Track state
    if (proxyIdx >= 0 && proxyState[proxyIdx]) {
        proxyState[proxyIdx].active++;
    }
    
    // Generate token
    console.log(`[${botName}] Generating token...`);
    const token = await generateToken(agent, proxyIdx);
    
    if (!token) {
        console.error(`[${botName}] Token generation failed. Closing.`);
        if (proxyIdx >= 0 && proxyState[proxyIdx]) proxyState[proxyIdx].active--;
        clientSocket.close();
        return;
    }
    
    // Add jitter before connecting (matching working version)
    await sleep(rint(DIAL_JITTER_MS[0], DIAL_JITTER_MS[1]));
    
    console.log(`[${botName}] Connecting to MooMoo...`);
    
    const hostOnly = region.split(':')[0];
    const moomooUrl = `wss://${region}/?token=${encodeURIComponent(token)}`;
    
    const wsOptions = {
        servername: hostOnly,
        headers: {
            'Origin': BROWSER_HEADERS.Origin,
            'User-Agent': BROWSER_HEADERS['User-Agent'],
            'Referer': BROWSER_HEADERS.Referer,
            'Accept-Language': BROWSER_HEADERS['Accept-Language']
        },
        perMessageDeflate: false
    };
    
    if (agent) {
        wsOptions.agent = agent;
    }
    
    const upstream = new WebSocket(moomooUrl, wsOptions);
    let keepAliveTimer = null;
    let upstreamReady = false;
    
    // Cleanup function (matching working version's pattern)
    const cleanup = () => {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        if (proxyIdx >= 0 && proxyState[proxyIdx]) {
            proxyState[proxyIdx].active--;
        }
        // Remove listeners to prevent memory leaks
        clientSocket.off('message', onClientMessage);
        clientSocket.off('close', onClientClose);
        clientSocket.off('error', onClientError);
    };
    
    // Message handlers
    const onUpstreamMessage = (msg) => {
        if (clientSocket.readyState === WebSocket.OPEN) {
            try { clientSocket.send(msg); } catch (e) {}
        }
    };
    
    const onClientMessage = (msg) => {
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
            try { upstream.send(msg); } catch (e) {}
        }
    };
    
    const onClientClose = () => {
        console.log(`[${botName}] Client closed`);
        cleanup();
        try { upstream.close(); } catch (e) {}
    };
    
    const onClientError = (e) => {
        console.error(`[${botName}] Client error:`, e.message);
    };
    
    // Attach client listeners
    clientSocket.on('message', onClientMessage);
    clientSocket.on('close', onClientClose);
    clientSocket.on('error', onClientError);
    
    // Upstream events
    upstream.on('open', () => {
        console.log(`[${botName}] CONNECTED to MooMoo via ${proxyHost}!`);
        upstreamReady = true;
        
        // Start keepalive
        keepAliveTimer = setInterval(() => {
            try {
                if (upstream.readyState === WebSocket.OPEN) {
                    upstream.ping();
                }
            } catch (e) {}
        }, KEEPALIVE_MS);
    });
    
    upstream.on('message', onUpstreamMessage);
    
    upstream.on('pong', () => {
        // Connection alive
    });
    
    upstream.on('close', (code, reasonBuf) => {
        let reason = '';
        try { 
            reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf || ''); 
        } catch {}
        
        console.log(`[${botName}] MooMoo closed (code=${code}${reason ? `, reason=${reason}` : ''})`);
        upstreamReady = false;
        cleanup();
        
        // Close client connection
        try { clientSocket.close(); } catch (e) {}
    });
    
    upstream.on('error', (e) => {
        console.error(`[${botName}] MooMoo error:`, e.message);
        upstreamReady = false;
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`[Proxy] Server running on port ${PORT}`);
    console.log(`[Proxy] Health: http://localhost:${PORT}/health`);
});

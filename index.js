// ===========================================================================
// MOOMOO.IO WEBSOCKET PROXY - CLOUD HOSTED VERSION
// ===========================================================================
// Deploy to Railway.app, Render.com, Fly.io, or similar
//
// Environment Variables (set in dashboard):
//   PROXIES = http://user:pass@host:port,http://user2:pass2@host2:port2
//   PORT = (auto-set by platform)
//
// ===========================================================================

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Try to load SOCKS support
let SocksProxyAgent;
try {
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (e) {
    console.log('[Proxy] SOCKS support not available');
}

// Configuration
const PORT = process.env.PORT || 8080;

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://moomoo.io',
    'Referer': 'https://moomoo.io/',
    'Accept-Language': 'en-US,en;q=0.9'
};

// Load proxies from environment variable
let proxyList = [];
let proxyIndex = 0;

function loadProxies() {
    const proxiesEnv = process.env.PROXIES || '';
    
    if (!proxiesEnv) {
        console.error('[Proxy] No PROXIES environment variable set!');
        console.log('[Proxy] Set PROXIES=http://user:pass@host:port,http://user2:pass2@host2:port2');
        return false;
    }
    
    proxyList = proxiesEnv.split(',').map(p => p.trim()).filter(Boolean);
    
    if (proxyList.length === 0) {
        console.error('[Proxy] No valid proxies found in PROXIES env var');
        return false;
    }
    
    console.log(`[Proxy] Loaded ${proxyList.length} proxy(ies) from environment`);
    return true;
}

function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[proxyIndex % proxyList.length];
    proxyIndex++;
    return proxy;
}

function makeAgent(proxyUrl) {
    if (!proxyUrl) return null;
    
    if (/^socks/i.test(proxyUrl)) {
        if (!SocksProxyAgent) {
            console.error('[Proxy] SOCKS proxy requested but not supported');
            return null;
        }
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

// Token generation through external proxy
function generateToken(agent) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.moomoo.io',
            path: '/verify',
            method: 'GET',
            agent: agent,
            headers: BROWSER_HEADERS,
            timeout: 15000
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const { challenge, salt, maxnumber, signature } = json;
                    
                    if (!challenge || !salt || maxnumber === undefined) {
                        console.error('[Token] Invalid challenge data');
                        resolve(null);
                        return;
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
                                took: 'cloud-proxy'
                            };
                            resolve('alt:' + Buffer.from(JSON.stringify(payload)).toString('base64'));
                            return;
                        }
                    }
                    
                    console.error('[Token] Failed to solve');
                    resolve(null);
                } catch (e) {
                    console.error('[Token] Parse error:', e.message);
                    resolve(null);
                }
            });
        });
        
        req.on('timeout', () => {
            console.error('[Token] Request timeout');
            req.destroy();
            resolve(null);
        });
        
        req.on('error', (e) => {
            console.error('[Token] Request error:', e.message);
            resolve(null);
        });
        
        req.end();
    });
}

// Load proxies
if (!loadProxies()) {
    console.error('[Proxy] WARNING: Running without external proxies. Connections may be rate-limited.');
}

// Create HTTP server (required for cloud platforms)
const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            status: 'ok',
            proxies: proxyList.length,
            usage: 'Connect via WebSocket to wss://YOUR-APP-URL/?region=xxx.moomoo.io'
        }));
        return;
    }
    
    res.writeHead(404);
    res.end('Not found');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

console.log(`[Proxy] Starting WebSocket server on port ${PORT}...`);

wss.on('connection', async (clientWs, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const region = url.searchParams.get('region');
    const botName = url.searchParams.get('name') || 'SyncBot';
    
    console.log(`[${botName}] New connection, region: ${region}`);
    
    if (!region || !/\.moomoo\.io$/i.test(region)) {
        console.error(`[${botName}] Invalid region "${region}". Closing.`);
        clientWs.close(1008, 'Invalid region');
        return;
    }
    
    // Get external proxy (if available)
    const proxyUrl = getNextProxy();
    let agent = null;
    let proxyHost = 'direct';
    
    if (proxyUrl) {
        agent = makeAgent(proxyUrl);
        proxyHost = getProxyHost(proxyUrl);
        console.log(`[${botName}] Using proxy: ${proxyHost}`);
    } else {
        console.log(`[${botName}] No proxy available, using direct connection`);
    }
    
    // Message queue
    const messageQueue = [];
    let upstreamReady = false;
    
    // Generate token
    console.log(`[${botName}] Generating token...`);
    const token = await generateToken(agent);
    
    if (!token) {
        console.error(`[${botName}] Token generation failed. Closing.`);
        clientWs.close(1011, 'Token generation failed');
        return;
    }
    
    console.log(`[${botName}] Token ready, connecting to MooMoo...`);
    
    // Build upstream URL
    const hostOnly = region.split(':')[0];
    const moomooUrl = `wss://${region}/?token=${encodeURIComponent(token)}`;
    
    // WebSocket options
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
    
    // Connect to MooMoo
    const upstream = new WebSocket(moomooUrl, wsOptions);
    
    // Keepalive ping interval
    let keepAliveInterval = null;
    const KEEPALIVE_MS = 20000; // Ping every 20 seconds
    
    upstream.on('open', () => {
        console.log(`[${botName}] CONNECTED to MooMoo via ${proxyHost}!`);
        upstreamReady = true;
        
        // Start keepalive pings
        keepAliveInterval = setInterval(() => {
            try {
                if (upstream.readyState === WebSocket.OPEN) {
                    upstream.ping();
                }
            } catch (e) {
                console.error(`[${botName}] Keepalive ping error:`, e.message);
            }
        }, KEEPALIVE_MS);
        
        // Flush queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            upstream.send(msg);
        }
    });
    
    upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });
    
    // Handle pong responses (optional logging)
    upstream.on('pong', () => {
        // Connection is alive
    });
    
    upstream.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : '';
        console.log(`[${botName}] MooMoo closed: ${code} ${reasonStr}`);
        upstreamReady = false;
        
        // Clear keepalive
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        if (clientWs.readyState === WebSocket.OPEN) {
            // WebSocket close codes 1004-1006 and 1015 are reserved and cannot be sent
            // Use 1000 (normal) or 1001 (going away) instead
            const safeCode = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
            try {
                clientWs.close(safeCode, reasonStr.slice(0, 123)); // reason max 123 bytes
            } catch (e) {
                console.error(`[${botName}] Error closing client:`, e.message);
                try { clientWs.terminate(); } catch {}
            }
        }
    });
    
    upstream.on('error', (err) => {
        console.error(`[${botName}] MooMoo error:`, err.message);
        upstreamReady = false;
        
        // Clear keepalive
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        if (clientWs.readyState === WebSocket.OPEN) {
            try {
                clientWs.close(1011, 'Upstream error');
            } catch (e) {
                try { clientWs.terminate(); } catch {}
            }
        }
    });
    
    // Client -> MooMoo
    clientWs.on('message', (data) => {
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
            upstream.send(data);
        } else {
            messageQueue.push(data);
        }
    });
    
    clientWs.on('close', (code, reason) => {
        console.log(`[${botName}] Client closed`);
        
        // Clear keepalive
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        if (upstream.readyState === WebSocket.OPEN) {
            try {
                upstream.close();
            } catch (e) {
                try { upstream.terminate(); } catch {}
            }
        }
    });
    
    clientWs.on('error', (err) => {
        console.error(`[${botName}] Client error:`, err.message);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`[Proxy] Server running on port ${PORT}`);
    console.log(`[Proxy] Health check: http://localhost:${PORT}/health`);
    console.log(`[Proxy] WebSocket: ws://localhost:${PORT}/?region=xxx.moomoo.io`);
});

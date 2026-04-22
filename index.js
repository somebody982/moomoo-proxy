const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ==========================================
// ZOMBIE COMMANDER PROXY v6 — ROTATING SOCKS5 PROXY
// ==========================================
const PORT = process.env.PORT || 8080;

// ========== LOAD PROXIES FROM SECRET FILE ==========
let PROXY_LIST =[];
try {
    // Reads the proxy list securely provided by Render Secret Files
    const proxyData = fs.readFileSync('proxies.json', 'utf8');
    PROXY_LIST = JSON.parse(proxyData);
    console.log(`[+] Successfully loaded ${PROXY_LIST.length} proxies from proxies.json`);
} catch (err) {
    console.error('[!] Failed to load proxies.json. Make sure the Secret File is configured in Render.');
    PROXY_LIST =[];
}

let proxyCursor = 0;
function getNextProxy() {
    if (PROXY_LIST.length === 0) return null;
    const p = PROXY_LIST[proxyCursor];
    proxyCursor = (proxyCursor + 1) % PROXY_LIST.length;
    return p;
}

// ========== SOCKS5 PROXY AGENT ==========
function getProxyAgent(proxy) {
    if (!proxy) return new https.Agent(); // Fallback to direct if no proxies exist
    
    // Construct the SOCKS5 connection URI using credentials
    // Using encodeURIComponent protects against special characters in usernames/passwords
    const proxyUrl = `socks5://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@${proxy.host}:${proxy.port}`;
    
    return new SocksProxyAgent(proxyUrl);
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://moomoo.io',
    'Referer': 'https://moomoo.io/',
    'Accept-Language': 'en-US,en;q=0.9'
};

// ========== SERIALIZED TOKEN FETCHING ==========
let tokenChain = Promise.resolve();

function generateToken(logName, agent, label) {
    tokenChain = tokenChain.catch(() => {}).then(() => _generateToken(logName, agent, label));
    return tokenChain;
}

function _generateToken(logName, tokenAgent, label) {
    return new Promise((resolve) => {
        console.log(`[${logName}] Fetching token via ${label}...`);
        const start = Date.now();

        const req = https.request({
            hostname: 'api.moomoo.io',
            path: '/verify',
            method: 'GET',
            agent: tokenAgent, // Connects via SOCKS5 proxy
            headers: HEADERS
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.log(`[X] Verify HTTP ${res.statusCode} (${Date.now() - start}ms)`);
                        return resolve(null);
                    }

                    const data = JSON.parse(body);
                    for (let i = 0; i <= data.maxnumber; i++) {
                        if (crypto.createHash('sha256').update(data.salt + i).digest('hex') === data.challenge) {
                            console.log(`[${logName}] Token solved in ${Date.now() - start}ms (n=${i})`);
                            return resolve('alt:' + Buffer.from(JSON.stringify({
                                algorithm: 'SHA-256',
                                challenge: data.challenge,
                                salt: data.salt,
                                number: i,
                                signature: data.signature,
                                took: Date.now() - start
                            })).toString('base64'));
                        }
                    }
                    console.log(`[X] ${logName}: Unsolvable (maxnumber=${data.maxnumber})`);
                    resolve(null);
                } catch (e) {
                    console.log(`[X] Token Parse Error: ${e.message}`);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.log(`[X] Token Request Error: ${e.message}`);
            resolve(null);
        });

        req.end();
    });
}

// ========== SERVER SETUP ==========
const server = http.createServer();

const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false
});

server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
});

// ========== CONNECTION HANDLER ==========
wss.on('connection', async (clientWs, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const target = url.searchParams.get('region') || url.searchParams.get('target');
    const botName = url.searchParams.get('name') || 'Zombie';

    if (!target) {
        console.log(`[X] Rejected: No region.`);
        return clientWs.close();
    }

    const proxy = getNextProxy();
    const connAgent = getProxyAgent(proxy);
    const connLabel = proxy ? `SOCKS5 ${proxy.host}:${proxy.port}` : 'Direct Connection';

    const connStart = Date.now();
    console.log(`\n[+] ${botName} -> ${target} via ${connLabel}`);

    // Queue for messages received before upstream is ready
    const messageQueue =[];
    let upstreamReady = false;
    let gameWs; 

    // ==========================================
    // POWERLINE.IO BYPASS VALVE
    // ==========================================
    if (target.includes('powerline.io') || url.searchParams.get('game') === 'powerline') {
        console.log(`[Powerline] Proxying raw binary connection...`);
        
        // Attach listener immediately so no browser packets are lost
        clientWs.on('message', (data) => {
            if (upstreamReady && gameWs && gameWs.readyState === WebSocket.OPEN) {
                gameWs.send(data);
            } else {
                messageQueue.push(data);
            }
        });

        // Connect directly to Powerline with correct subprotocol and headers
        gameWs = new WebSocket(`wss://${target}/`, "1707805", {
            agent: connAgent,
            headers: { 
                'Origin': 'https://powerline.io', 
                'User-Agent': HEADERS['User-Agent'] 
            },
            rejectUnauthorized: false
        });

        gameWs.on('open', () => {
            const elapsed = Date.now() - connStart;
            console.log(`[>>] ${botName} CONNECTED to Powerline in ${elapsed}ms`);
            upstreamReady = true;
            
            // Flush the buffer!
            while (messageQueue.length > 0) {
                const msg = messageQueue.shift();
                if (gameWs.readyState === WebSocket.OPEN) gameWs.send(msg);
            }
        });

        gameWs.on('message', (data) => {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
        });

        const cleanup = () => {
            if (gameWs.readyState <= WebSocket.OPEN) gameWs.close();
            if (clientWs.readyState <= WebSocket.OPEN) clientWs.close();
        };

        gameWs.on('close', (code, reason) => { console.log(`[-] ${botName} Powerline DC (${code})`); cleanup(); });
        clientWs.on('close', () => cleanup());
        gameWs.on('error', (e) => { console.log(`[X] ${botName} Powerline Error: ${e.message}`); cleanup(); });
        clientWs.on('error', () => cleanup());
        
        return; // EXIT HERE: Do not run Moomoo.io token generation!
    }

    // ==========================================
    // MOOMOO.IO LOGIC (Unchanged)
    // ==========================================
    
    const token = await generateToken(botName, connAgent, connLabel);
    if (!token) {
        console.log(`[X] ${botName}: Token failed.`);
        return clientWs.close();
    }

    // Attach relay listener
    clientWs.on('message', (data) => {
        if (upstreamReady && gameWs && gameWs.readyState === WebSocket.OPEN) {
            gameWs.send(data);
        } else {
            messageQueue.push(data);
        }
    });

    // Connect to Game
    const hostOnly = target.split(':')[0];
    gameWs = new WebSocket(`wss://${target}/?token=${encodeURIComponent(token)}`, {
        agent: connAgent, 
        servername: hostOnly,
        headers: HEADERS,
        perMessageDeflate: false,
        skipUTF8Validation: true
    });

    gameWs.on('open', () => {
        const elapsed = Date.now() - connStart;
        console.log(`[>>] ${botName} CONNECTED to Moomoo in ${elapsed}ms`);

        upstreamReady = true;
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            if (gameWs.readyState === WebSocket.OPEN) {
                gameWs.send(msg);
            }
        }
    });

    gameWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    const cleanup = () => {
        if (gameWs.readyState <= WebSocket.OPEN) gameWs.close();
        if (clientWs.readyState <= WebSocket.OPEN) clientWs.close();
    };

    gameWs.on('close', (code, reason) => {
        console.log(`[-] ${botName} Game DC (${code}) ${reason || ''}`);
        cleanup();
    });

    clientWs.on('close', (code) => {
        console.log(`[-] ${botName} Client DC (${code})`);
        cleanup();
    });

    gameWs.on('error', (e) => {
        console.log(`[X] ${botName} Game Error: ${e.message}`);
        cleanup();
    });

    clientWs.on('error', (e) => {
        console.log(`[X] ${botName} Client Error: ${e.message}`);
        cleanup();
    });
});

// ========== STARTUP ==========
server.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`  UNIVERSAL COMMANDER v6.1 — SOCKS5 ENABLED`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Proxy Pool: ${PROXY_LIST.length} proxies loaded`);
    console.log(`==============================================\n`);
});

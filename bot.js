const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const http = require('http');
const localConfig = require('./config.json');

const config = {
    server: {
        host: process.env.SERVER_HOST || localConfig.server?.host || "raven-mc.net",
        port: parseInt(process.env.SERVER_PORT || localConfig.server?.port || 25565, 10)
    },
    bot: {
        name: process.env.BOT_NAME || localConfig.bot?.name || "atomic",
        auth: process.env.BOT_AUTH || localConfig.bot?.auth || "offline",
        version: process.env.BOT_VERSION === 'false' ? false : (process.env.BOT_VERSION || localConfig.bot?.version || false)
    },
    login: {
        command: process.env.LOGIN_COMMAND || localConfig.login?.command || "/login 7717101"
    },
    selector: {
        compassNameKeywords: process.env.COMPASS_KEYWORDS ? process.env.COMPASS_KEYWORDS.split(',') : (localConfig.selector?.compassNameKeywords || ["compass", "SERVER", "Selector"]),
        targetSlot: parseInt(process.env.TARGET_SLOT || localConfig.selector?.targetSlot || 10, 10)
    },
    antiAfk: {
        moveDurationMin: parseInt(process.env.AFK_MOVE_MIN || localConfig.antiAfk?.moveDurationMin || 3000, 10),
        moveDurationMax: parseInt(process.env.AFK_MOVE_MAX || localConfig.antiAfk?.moveDurationMax || 8000, 10),
        pauseMin: parseInt(process.env.AFK_PAUSE_MIN || localConfig.antiAfk?.pauseMin || 8000, 10),
        pauseMax: parseInt(process.env.AFK_PAUSE_MAX || localConfig.antiAfk?.pauseMax || 20000, 10),
        jumpChance: parseFloat(process.env.AFK_JUMP_CHANCE || localConfig.antiAfk?.jumpChance || 0.5),
        sneakChance: parseFloat(process.env.AFK_SNEAK_CHANCE || localConfig.antiAfk?.sneakChance || 0.3),
        sprintChance: parseFloat(process.env.AFK_SPRINT_CHANCE || localConfig.antiAfk?.sprintChance || 0.2)
    },
    reconnect: {
        baseDelay: parseInt(process.env.RECONNECT_BASE || localConfig.reconnect?.baseDelay || 5000, 10),
        maxDelay: parseInt(process.env.RECONNECT_MAX || localConfig.reconnect?.maxDelay || 30000, 10),
        jitter: parseInt(process.env.RECONNECT_JITTER || localConfig.reconnect?.jitter || 2000, 10)
    },
    web: {
        enabled: process.env.WEB_ENABLED !== 'false' && (localConfig.web?.enabled !== false),
        port: parseInt(process.env.PORT || localConfig.web?.port || 8080, 10)
    }
};


// ============================================================
// GLOBALS
// ============================================================
let bot = null;
let reconnectTimer = null;
let isConnecting = false;
let reconnectAttempts = 0;
let botStatus = 'initializing';
let lastError = '';

// ============================================================
// WEB STATUS SERVER – keeps deployment alive and shows status
// ============================================================
if (config.web.enabled) {
    const port = process.env.PORT || config.web.port;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
            <head><title>NEUTRONNNN_BOT</title>
            <style>
                body{background:#0d0d0d;color:#0f0;font-family:monospace;padding:20px;}
                .status{font-size:24px;border:1px solid #0f0;padding:10px;display:inline-block;}
            </style>
            </head>
            <body>
            <h1>⚡ NEUTRONNNN_KILLER BOT</h1>
            <div class="status">Status: ${botStatus}</div>
            <p>Last error: ${lastError || 'None'}</p>
            <p>Reconnect attempts: ${reconnectAttempts}</p>
            <p>Target: ${config.server.host}:${config.server.port}</p>
            <p>Bot name: ${config.bot.name}</p>
            <p><small>Created for sir @N3UTRON</small></p>
            </body>
            </html>
        `);
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[WEB] Port ${port} already in use, trying ${port + 1}...`);
            server.listen(port + 1, () => {
                console.log(`[WEB] Status server running on fallback port ${port + 1}`);
            });
        } else {
            console.error(`[WEB] Server error: ${err.message}`);
        }
    });
    server.listen(port, () => {
        console.log(`[WEB] Status server running on port ${port}`);
    });
}

// ============================================================
// PING SERVER – check if reachable before connecting
// ============================================================
function pingServer(host, port) {
    return new Promise((resolve) => {
        mc.ping({ host, port, version: false }, (err, data) => {
            if (err) {
                console.log(`[PING] Server unreachable: ${err.message}`);
                resolve(false);
            } else {
                console.log(`[PING] Server online: ${data.version.name} (protocol ${data.version.protocol})`);
                console.log(`[PING] Players: ${data.players.online}/${data.players.max}`);
                resolve(true);
            }
        });
    });
}

// ============================================================
// CREATE THE BOT
// ============================================================
function createBot() {
    if (isConnecting) return;
    isConnecting = true;
    botStatus = 'connecting';

    console.log(`[BOT] Creating bot '${config.bot.name}' for ${config.server.host}:${config.server.port} ...`);

    bot = mineflayer.createBot({
        host: config.server.host,
        port: config.server.port,
        username: config.bot.name,
        auth: config.bot.auth,
        version: config.bot.version,          // false = auto-negotiate
        checkTimeoutInterval: 60000,
        keepAlive: true,
        brand: 'vanilla',                     // mimic vanilla client
    });

    // -------- EVENT: CONNECTED --------
    bot.on('connect', () => {
        console.log('[BOT] TCP connection established.');
        botStatus = 'connected';
    });

    // -------- EVENT: LOGIN --------
    bot.on('login', () => {
        console.log('[BOT] Login successful.');
        botStatus = 'logged_in';
    });

    // -------- EVENT: SPAWN (we are fully in the world) --------
    bot.once('spawn', () => {
        isConnecting = false;
        reconnectAttempts = 0;
        botStatus = 'spawned';
        console.log(`[BOT] Spawned successfully as ${config.bot.name}.`);

        // 1. Send /login command after 1.5s
        setTimeout(() => {
            bot.chat(config.login.command);
            console.log('[BOT] Sent login command.');
        }, 1500);

        // 2. Find and use the compass (with retries)
        let compassAttempts = 0;
        const findCompass = () => {
            if (compassAttempts > 5) {
                console.warn('[BOT] Compass not found after 5 attempts. Skipping selector.');
                return;
            }
            // Look for an item whose name or displayName contains any keyword
            const compass = bot.inventory.items().find(item =>
                config.selector.compassNameKeywords.some(kw =>
                    item.name.includes(kw) ||
                    (item.displayName && item.displayName.includes(kw))
                )
            );
            if (compass) {
                console.log(`[BOT] Found compass: ${compass.displayName || compass.name}`);
                bot.equip(compass, 'hand', (err) => {
                    if (err) {
                        console.error(`[BOT] Failed to equip compass: ${err}`);
                        return;
                    }
                    // Right-click to open the Server Selector GUI
                    bot.activateItem();
                    console.log('[BOT] Activated compass (Server Selector opened).');

                    // Wait for GUI to open, then click slot 11 (index 10)
                    setTimeout(() => {
                        const window = bot.openContainer;
                        if (window) {
                            const slot = config.selector.targetSlot; // 10
                            bot.clickWindow(slot, 0, 0);
                            console.log(`[BOT] Clicked slot ${slot} (Survival/Diamond Pickaxe). Teleporting...`);
                        } else {
                            console.warn('[BOT] No container window opened after using compass.');
                        }
                    }, 1500);
                });
            } else {
                compassAttempts++;
                console.log(`[BOT] Compass not yet found (attempt ${compassAttempts}), retrying in 2s...`);
                setTimeout(findCompass, 2000);
            }
        };
        // Start searching after 4 seconds (enough time for login to complete)
        setTimeout(findCompass, 4000);

        // 3. Send /afk after teleport (8s total from spawn)
        setTimeout(() => {
            bot.chat('/afk');
            console.log('[BOT] Sent /afk. Starting anti-AFK in 10s.');
        }, 8000);

        // 4. Start anti-AFK movements after 18s (8s + 10s wait)
        setTimeout(() => {
            console.log('[BOT] Starting anti-AFK movements.');
            startAntiAfk();
        }, 18000);
    });

    // -------- EVENT: KICKED --------
    bot.on('kick', (reason) => {
        console.log(`[BOT] Kicked from server. Reason: ${reason}`);
        botStatus = 'kicked';
        lastError = reason;
        scheduleReconnect('kick');
    });

    // -------- EVENT: CONNECTION END --------
    bot.on('end', (reason) => {
        console.log(`[BOT] Connection ended. Reason: ${reason || 'unknown'}`);
        botStatus = 'disconnected';
        lastError = reason || 'socketClosed';
        scheduleReconnect('end');
    });

    // -------- EVENT: ERROR --------
    bot.on('error', (err) => {
        console.error(`[BOT] Internal error: ${err.message}`);
        lastError = err.message;
        // Reconnect only for network-level errors
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('socket')) {
            scheduleReconnect('error');
        }
    });
}

// ============================================================
// RECONNECTION LOGIC (with exponential backoff and jitter)
// ============================================================
function scheduleReconnect(source) {
    if (reconnectTimer || isConnecting) return;
    reconnectAttempts++;
    // baseDelay + (attempts * 3s), capped at maxDelay, plus random jitter
    let delay = Math.min(
        config.reconnect.baseDelay + (reconnectAttempts * 3000),
        config.reconnect.maxDelay
    );
    delay += Math.floor(Math.random() * config.reconnect.jitter);

    console.log(`[RECONNECT] Attempt #${reconnectAttempts} in ${(delay/1000).toFixed(1)}s (source: ${source})`);
    botStatus = `reconnecting (${reconnectAttempts})`;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (bot) {
            try { bot.end(); } catch (e) {}
            bot = null;
        }
        // Ping server to ensure it's alive before reconnecting
        pingServer(config.server.host, config.server.port).then((alive) => {
            if (!alive) {
                console.warn('[RECONNECT] Server appears offline, waiting longer...');
                setTimeout(() => createBot(), 10000);
            } else {
                createBot();
            }
        });
    }, delay);
}

// ============================================================
// ANTI-AFK – human-like random movements to avoid being kicked
// ============================================================
let afkInterval = null;

function startAntiAfk() {
    if (afkInterval) clearInterval(afkInterval);

    const performRandomMove = () => {
        if (!bot || !bot.entity) {
            console.warn('[ANTI-AFK] Bot not available, stopping movements.');
            return;
        }

        const actions = ['forward', 'back', 'left', 'right'];
        const action = actions[Math.floor(Math.random() * actions.length)];
        const duration = config.antiAfk.moveDurationMin +
            Math.random() * (config.antiAfk.moveDurationMax - config.antiAfk.moveDurationMin);

        // Start moving
        bot.setControlState(action, true);
        console.log(`[ANTI-AFK] Moving ${action} for ${(duration/1000).toFixed(1)}s`);

        // Random jump during movement
        if (Math.random() < config.antiAfk.jumpChance) {
            setTimeout(() => {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 300 + Math.random() * 500);
            }, 500 + Math.random() * 800);
        }

        // Randomly change look direction
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() * Math.PI / 1.5) - Math.PI / 3;
        bot.look(yaw, pitch, true);

        // Random sneak
        if (Math.random() < config.antiAfk.sneakChance) {
            bot.setControlState('sneak', true);
            setTimeout(() => bot.setControlState('sneak', false), 1000 + Math.random() * 1500);
        }

        // Random sprint
        if (Math.random() < config.antiAfk.sprintChance) {
            bot.setControlState('sprint', true);
            setTimeout(() => bot.setControlState('sprint', false), 1500 + Math.random() * 2000);
        }

        // Stop movement after duration
        setTimeout(() => {
            bot.setControlState(action, false);
            // Clean up any leftover controls
            setTimeout(() => {
                bot.setControlState('jump', false);
                bot.setControlState('sneak', false);
                bot.setControlState('sprint', false);
            }, 300);
        }, duration);
    };

    // Recursive loop with random pause between moves
    const loop = () => {
        if (!bot || !bot.entity) {
            console.warn('[ANTI-AFK] Bot ended, stopping loop.');
            return;
        }
        performRandomMove();
        const nextDelay = config.antiAfk.pauseMin +
            Math.random() * (config.antiAfk.pauseMax - config.antiAfk.pauseMin);
        setTimeout(loop, nextDelay);
    };

    // Start after a short delay
    setTimeout(loop, 2000);
}

// ============================================================
// KEEP-ALIVE HEARTBEAT – prevents Node from exiting
// ============================================================
setInterval(() => {
    // dummy – keeps the event loop alive
}, 60000);

// ============================================================
// UNCAUGHT EXCEPTION HANDLER – last-resort crash recovery
// ============================================================
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}`);
    lastError = err.message;
    if (bot) {
        try { bot.end(); } catch (e) {}
        bot = null;
    }
    setTimeout(() => createBot(), 3000);
});

// ============================================================
// START THE BOT
// ============================================================
console.log('[SYSTEM] NEUTRONNNN_KILLER bot v2.0 initialized for sir @N3UTRON.');
pingServer(config.server.host, config.server.port).then((alive) => {
    if (alive) {
        createBot();
    } else {
        console.error('[SYSTEM] Server unreachable, will retry in 10s.');
        setTimeout(() => createBot(), 10000);
    }
});
const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const http = require('http');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
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
    },
    afk: {
        x: 228,
        y: 118,
        z: -258,
        yaw: -1.7,   // degrees, from F3
        pitch: -12.1  // degrees, from F3
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
// SAFE REGISTRIES – prevents cross-connection leaks
// ============================================================
let activeTimeouts = [];
let activeIntervals = [];

function safeSetTimeout(fn, delay) {
    const timer = setTimeout(() => {
        activeTimeouts = activeTimeouts.filter(t => t !== timer);
        fn();
    }, delay);
    activeTimeouts.push(timer);
    return timer;
}
function clearAllTimeouts() {
    activeTimeouts.forEach(clearTimeout);
    activeTimeouts = [];
}

function safeSetInterval(fn, delay) {
    const timer = setInterval(fn, delay);
    activeIntervals.push(timer);
    return timer;
}
function clearAllIntervals() {
    activeIntervals.forEach(clearInterval);
    activeIntervals = [];
}

// Helper to determine if we are in the lobby or survival
function isCurrentlyInLobby() {
    if (!bot) return true;
    if (!bot.entity || !bot.entity.position) return true;
    
    // 1. If dimension is the_end or unknown, we are in auth/lobby
    const dim = bot.game ? bot.game.dimension : 'unknown';
    if (!dim || dim === 'unknown' || dim.includes('the_end')) return true;

    // 2. Check scoreboard for lobby text safely
    if (bot.scoreboards) {
        for (const name in bot.scoreboards) {
            const sb = bot.scoreboards[name];
            const titleStr = sb.title ? (typeof sb.title === 'string' ? sb.title : JSON.stringify(sb.title)).toLowerCase() : '';
            if (titleStr.includes('lobby')) return true;
            if (sb.itemsMap) {
                for (const key in sb.itemsMap) {
                    const item = sb.itemsMap[key];
                    const nameStr = item.displayName ? (typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName)).toLowerCase() : '';
                    if (nameStr.includes('lobby')) return true;
                }
            }
        }
    }

    // 3. Check hotbar slot 5 (index 4) for compass selector
    if (bot.inventory) {
        const slot5Item = bot.inventory.slots[36 + 4]; // Hotbar is slots 36-44
        if (slot5Item && (slot5Item.name === 'compass' || slot5Item.name === 'recovery_compass')) {
            return true;
        }
    }

    return false;
}

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

    clearAllTimeouts();
    clearAllIntervals();

    let hasLoggedIn = false;
    let hasTeleported = false;
    let hasStartedWalking = false;
    let spawnCount = 0;
    let teleportTimeout = null;
    let loginTimeout = null;

    console.log(`[BOT] Creating bot '${config.bot.name}' for ${config.server.host}:${config.server.port} ...`);

    bot = mineflayer.createBot({
        host: config.server.host,
        port: config.server.port,
        username: config.bot.name,
        auth: config.bot.auth,
        version: config.bot.version || '1.20.4',
        checkTimeoutInterval: 60000,
        keepAlive: true,
    });

    // DIAGNOSTIC MONITOR: Logs the bot's state every 5 seconds to debug server transition
    safeSetInterval(() => {
        if (!bot) return;
        const dim = bot.game ? bot.game.dimension : 'unknown';
        const slot5 = bot.inventory ? bot.inventory.slots[36 + 4] : null;
        const sbNames = bot.scoreboards ? Object.keys(bot.scoreboards) : [];
        const pos = (bot.entity && bot.entity.position) ? `(${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})` : 'unknown';
        console.log(`[DIAGNOSTIC] Dim: ${dim}, Pos: ${pos}, Slot 5: ${slot5 ? slot5.name : 'empty'}, Scoreboards: ${sbNames.join(', ')}`);
        if (bot.scoreboards) {
            for (const name in bot.scoreboards) {
                const sb = bot.scoreboards[name];
                console.log(`  - Scoreboard '${name}' Title: '${sb.title}'`);
            }
        }
    }, 5000);

    // DIMENSION / LOBBY MONITOR: Runs every 2s
    safeSetInterval(() => {
        if (!bot) return;
        
        const inLobby = isCurrentlyInLobby();
        const dim = bot.game ? bot.game.dimension : 'unknown';
        
        if (!inLobby && !hasStartedWalking) {
            console.log(`[MONITOR] Survival server confirmed (dimension: ${dim}). Starting survival routine...`);
            hasStartedWalking = true;
            hasTeleported = true;
            if (teleportTimeout) clearTimeout(teleportTimeout);
            safeSetTimeout(() => {
                onSurvivalJoined();
            }, 2000);
        } else if (inLobby && hasLoggedIn && !hasTeleported) {
            // Keep retrying compass selection if stuck in lobby
            if (!teleportTimeout) {
                console.log('[MONITOR] Still in lobby. Opening compass selector...');
                useCompassSelector();
            }
        }
    }, 2000);

    const performLogin = () => {
        if (hasLoggedIn) return;
        hasLoggedIn = true;
        bot.chat(config.login.command);
        console.log('[BOT] Sent login command.');
        
        // Wait 6 seconds. If we haven't spawned in a new world (which clears this), attempt manual compass selector.
        teleportTimeout = safeSetTimeout(() => {
            if (!hasTeleported) {
                console.log('[BOT] Auto-teleport did not happen. Attempting manual compass selector...');
                useCompassSelector();
            }
        }, 6000);
    };

    const useCompassSelector = () => {
        if (hasTeleported) return;
        console.log('[BOT] Selecting hotbar slot 5 and right-clicking...');
        bot.setQuickBarSlot(4); // Hotbar slot 5 (0-indexed = 4)
        
        safeSetTimeout(() => {
            if (hasTeleported) return;
            bot.activateItem();
            console.log('[BOT] Right-clicked hotbar slot 5. Waiting for server selector GUI...');
        }, 500);
    };

    // -------- EVENT: WINDOW OPEN (GUI) --------
    bot.on('windowOpen', (window) => {
        const targetSlot = config.selector.targetSlot; // 10
        const item = window.slots[targetSlot];
        console.log(`[BOT] GUI opened: ${window.title || 'Chest GUI'}. Slot ${targetSlot} contains: ${item ? `${item.name} (${item.displayName})` : 'empty'}. Waiting 1s before clicking...`);
        safeSetTimeout(() => {
            if (!bot || !bot.openContainer) return;
            bot.clickWindow(targetSlot, 0, 0).then(() => {
                console.log(`[BOT] Successfully clicked slot ${targetSlot}.`);
                hasTeleported = true;
            }).catch(err => {
                console.error(`[BOT] Error clicking window: ${err.message}`);
            });
        }, 1000);
    });

    // -------- EVENT: CONNECTED --------
    bot.on('connect', () => {
        console.log('[BOT] TCP connection established.');
        botStatus = 'connected';
        
        if (bot._client) {
            bot._client.on('disconnect', (packet) => {
                console.log(`[DEBUG] Disconnect packet: ${JSON.stringify(packet)}`);
            });
            bot._client.on('kick_disconnect', (packet) => {
                console.log(`[DEBUG] Kick packet: ${JSON.stringify(packet)}`);
            });
        }
    });

    // -------- EVENT: LOGIN --------
    let loginCount = 0;
    bot.on('login', () => {
        loginCount++;
        console.log(`[BOT] Login successful (stage: ${loginCount}).`);
        botStatus = 'logged_in';
        
        // Manually clear scoreboards on proxy transition to prevent stale lobby scoreboards in survival
        bot.scoreboards = {}; 
        
        if (loginCount === 1) {
            bot.physicsEnabled = false;
            console.log('[BOT] Stage 1 (Auth): Disabled physics to prevent proxy transfer crash.');
        } else if (loginCount === 2) {
            console.log('[BOT] Stage 2 (Lobby). Waiting for spawn event...');
        }
    });

    // -------- EVENT: MESSAGE (chat) --------
    bot.on('message', (jsonMsg) => {
        const msg = jsonMsg.toString();
        const msgLower = msg.toLowerCase().replace(/[^a-z0-9\/\s]/g, ''); // strip unicode junk for matching
        console.log(`[CHAT] ${msg}`);
        
        // Trigger login if prompted by chat (check LOGIN before register — account likely exists)
        if ((msgLower.includes('/login') || msgLower.includes('login')) && !hasLoggedIn) {
            console.log(`[CHAT] Server requested login via chat message.`);
            performLogin();
        }
        // Trigger register if prompted by chat
        else if ((msgLower.includes('/register') || msgLower.includes('register')) && !hasLoggedIn) {
            console.log(`[CHAT] Server requested registration. Using password from config.`);
            const parts = config.login.command.split(' ');
            if (parts.length >= 2) {
                const pass = parts[1];
                bot.chat(`/register ${pass} ${pass}`);
                hasLoggedIn = true;
            }
        }
        // Wait for successful login/register confirmation to use the compass
        else if ((msgLower.includes('successfully') || msgLower.includes('success') || msg.includes('ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ')) && hasLoggedIn && !hasTeleported) {
            console.log('[BOT] Login confirmed by server! Waiting 3 seconds before using compass selector...');
            safeSetTimeout(() => {
                if (botStatus === 'spawned' && !hasTeleported) {
                    useCompassSelector();
                }
            }, 3000);
        }
    });

    // -------- EVENT: SPAWN --------
    bot.on('spawn', () => {
        botStatus = 'spawned';
        spawnCount++;
        
        try {
            const dim = (bot.game && bot.game.dimension) ? bot.game.dimension : 'unknown';
            const posX = (bot.entity && bot.entity.position) ? bot.entity.position.x.toFixed(1) : 'unknown';
            const posY = (bot.entity && bot.entity.position) ? bot.entity.position.y.toFixed(1) : 'unknown';
            const posZ = (bot.entity && bot.entity.position) ? bot.entity.position.z.toFixed(1) : 'unknown';
            
            const inLobby = isCurrentlyInLobby();
            console.log(`[BOT] Spawn event #${spawnCount}. Dimension: ${dim}. Position: (${posX}, ${posY}, ${posZ}). Lobby: ${inLobby}`);

            // Check if we are in Survival
            if (!inLobby) {
                if (!hasTeleported) {
                    console.log('[BOT] Transitioned to Survival!');
                    hasTeleported = true;
                }
                bot.physicsEnabled = true;
                if (teleportTimeout) clearTimeout(teleportTimeout);
                
                safeSetTimeout(() => {
                    onSurvivalJoined();
                }, 2000);
            } else {
                // We are in Lobby/Auth
                if (spawnCount === 1) {
                    // AUTO-LOGIN: Send login command 3s after first spawn
                    loginTimeout = safeSetTimeout(() => {
                        if (!hasLoggedIn) {
                            console.log('[BOT] Auto-sending login command...');
                            performLogin();
                        }
                    }, 3000);
                } else if (hasLoggedIn && !hasTeleported) {
                    // If we are logged in but still in lobby, trigger the server selector
                    console.log('[BOT] Triggered server selector in lobby...');
                    safeSetTimeout(() => {
                        if (!hasTeleported) {
                            useCompassSelector();
                        }
                    }, 3000);
                }
            }
        } catch (err) {
            console.error(`[ERROR] Error in spawn handler: ${err.message}`);
        }
    });

    // -------- EVENT: RESPAWN --------
    bot.on('respawn', () => {
        const inLobby = isCurrentlyInLobby();
        console.log(`[BOT] Respawned. Lobby: ${inLobby}`);
        if (!inLobby) {
            safeSetTimeout(() => {
                onSurvivalJoined();
            }, 2000);
        }
    });

    // -------- EVENT: KICKED --------
    bot.on('kick', (reason) => {
        console.log(`[BOT] Kicked from server. Reason: ${reason}`);
        botStatus = 'kicked';
        lastError = reason;
        isConnecting = false;
        if (teleportTimeout) clearTimeout(teleportTimeout);
        if (loginTimeout) clearTimeout(loginTimeout);
        scheduleReconnect('kick');
    });

    // -------- EVENT: CONNECTION END --------
    bot.on('end', (reason) => {
        console.log(`[BOT] Connection ended. Reason: ${reason || 'unknown'}`);
        botStatus = 'disconnected';
        lastError = reason || 'socketClosed';
        isConnecting = false;
        if (teleportTimeout) clearTimeout(teleportTimeout);
        if (loginTimeout) clearTimeout(loginTimeout);
        scheduleReconnect('end');
    });

    // -------- EVENT: ERROR --------
    bot.on('error', (err) => {
        console.error(`[BOT] Internal error: ${err.message}`);
        lastError = err.message;
        isConnecting = false;
        // Reconnect only for network-level errors
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('socket')) {
            if (teleportTimeout) clearTimeout(teleportTimeout);
            if (loginTimeout) clearTimeout(loginTimeout);
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
// SURVIVAL ROUTINE – Send /afk, wait 15s, type "im afk", run around
// ============================================================
let survivalRoutineStarted = false;

function onSurvivalJoined() {
    if (survivalRoutineStarted) return;
    survivalRoutineStarted = true;

    console.log('[SURVIVAL] Step 1: Joined survival world! Waiting 3 seconds before sending /afk...');
    safeSetTimeout(() => {
        if (!bot || !bot.chat) return;
        try {
            console.log('[SURVIVAL] Step 1b: Sending /afk command...');
            bot.chat('/afk');
        } catch (err) {
            console.error(`[SURVIVAL] Failed to send /afk: ${err.message}`);
        }

        console.log('[SURVIVAL] Step 2: Waiting 15 seconds after /afk...');
        safeSetTimeout(() => {
            if (!bot || !bot.chat) return;
            try {
                console.log('[SURVIVAL] Step 3: 15s passed! Typing "im afk" in chat...');
                bot.chat('im afk');
            } catch (err) {
                console.error(`[SURVIVAL] Failed to send im afk: ${err.message}`);
            }

            console.log('[SURVIVAL] Step 4: Starting random running movement routine...');
            startRandomRunning();
        }, 15000);
    }, 3000);
}

let runningInterval = null;

function startRandomRunning() {
    if (runningInterval) clearInterval(runningInterval);

    const actions = ['forward', 'back', 'left', 'right'];

    const doRandomMove = () => {
        if (!bot || !bot.entity) return;

        // Reset control states
        actions.forEach(action => bot.setControlState(action, false));
        bot.setControlState('jump', false);
        bot.setControlState('sprint', false);
        bot.setControlState('sneak', false);

        // Pick direction
        const chosenDir = actions[Math.floor(Math.random() * actions.length)];
        bot.setControlState(chosenDir, true);

        // Randomly sprint, jump, or sneak
        if (Math.random() < 0.75) bot.setControlState('sprint', true);
        if (Math.random() < 0.45) bot.setControlState('jump', true);
        if (Math.random() < 0.15) bot.setControlState('sneak', true);

        // Turn head randomly
        const yaw = (Math.random() * 360 - 180) * (Math.PI / 180);
        const pitch = (Math.random() * 40 - 20) * (Math.PI / 180);
        bot.look(yaw, pitch, false);

        console.log(`[RUNNING] Active action: ${chosenDir}, sprint: ${bot.controlState.sprint}, jump: ${bot.controlState.jump}`);
    };

    doRandomMove();
    runningInterval = safeSetInterval(doRandomMove, 2000 + Math.floor(Math.random() * 2000));
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
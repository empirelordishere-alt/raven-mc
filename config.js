cat > config.json << 'EOF'
{
  "server": {
    "host": "raven-mc.net",
    "port": 25565
  },
  "bot": {
    "name": "atomic",
    "auth": "offline",
    "version": false
  },
  "login": {
    "command": "/login 7717101"
  },
  "selector": {
    "compassNameKeywords": ["compass", "SERVER", "Selector"],
    "targetSlot": 10
  },
  "antiAfk": {
    "moveDurationMin": 3000,
    "moveDurationMax": 8000,
    "pauseMin": 8000,
    "pauseMax": 20000,
    "jumpChance": 0.5,
    "sneakChance": 0.3,
    "sprintChance": 0.2
  },
  "reconnect": {
    "baseDelay": 5000,
    "maxDelay": 30000,
    "jitter": 2000
  },
  "web": {
    "enabled": true,
    "port": 8080
  }
}
EOF

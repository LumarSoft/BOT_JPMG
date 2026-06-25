module.exports = {
  apps: [
    {
      name: "john_bot",
      script: "dist/main.js", // el bot no tiene config raíz, compila directo a dist/main.js
      interpreter: "/root/.nvm/versions/node/v22.23.1/bin/node", // Node 22 (nvm), mismo que la API
      exec_mode: "fork", // fork para respetar el interpreter custom (no cluster)
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_file: "logs/combined.log",
      time: true,
      merge_logs: true,
    },
  ],
};

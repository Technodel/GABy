module.exports = {
  apps: [{
    name: 'suny',
    script: './dist/server/index.js',
    instances: 1,
    exec_mode: 'fork',
    
    // Zero-downtime deployment settings
    wait_ready: true,
    listen_timeout: 10000,
    kill_timeout: 5000,
    
    // Restart behavior
    restart_delay: 1000,
    max_restarts: 5,
    min_uptime: '10s',
    
    // Environment
    env: {
      NODE_ENV: 'production'
    },
    
    // Logging
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Auto-restart on failure
    autorestart: true,
    
    // Memory management
    max_memory_restart: '500M'
  }]
};

